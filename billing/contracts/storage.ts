import { createHash } from 'node:crypto';
import { termExpiry } from './service-term.js';
import { canonicalJson } from './canonical.js';
import { object, row, constant, choice, id, text, epoch, integer, positive, boolean, digest,
  identity, currency, correlation, snapshotSchema, entitlementSchema, orderSchema, compile, type Schema } from './schemas.js';
import { identityPartition, type Snapshot } from './validate.js';
import { sha256HexPattern } from '../../contracts/patterns.js';

const base = { ...row, environment: id, identity };
export const leaseSchema = object({ owner: id, fence: positive, expires_at: epoch });
const providerId = (prefix: string): Schema => ({ ...text, pattern: `^${prefix}_[A-Za-z0-9_]+$` });
export const quoteSchema = object({
  ...base, entity_type: constant('upgrade_quote'), quote_id: id, subscription_id: id,
  source_term_id: id, source_revision: integer, source_start: epoch, source_end: epoch,
  eligible_old_value_minor: integer, quote_at: epoch, expires_at: epoch,
  source_tier_order: integer, target_tier_order: integer, target: snapshotSchema,
  full_amount_minor: positive, credit_minor: integer, payable_minor: positive, currency,
  quote_digest: digest, state: choice('offered', 'confirmed', 'applied', 'expired', 'repair_required'),
});
const terminalEvidence = object({ outcome: choice('paid', 'terminal_unpaid'), provider_object_id: text, observed_at: epoch });
export const workSchema = object({
  ...base, entity_type: constant('reconciliation_work'), kind: constant('reconcile_payment'),
  order_id: id, operation_id: id, correlation_id: correlation, generation: positive, due_at: epoch, next_attempt_at: epoch,
  deadline: epoch, attempts: integer, state: choice('pending', 'complete', 'repair_required'),
  dispatch_status: choice('idle', 'claimed', 'sent', 'uncertain', 'exhausted'), dispatch_attempts: integer,
  dispatch_epoch: integer, processing_lease: leaseSchema, dispatch_lease: leaseSchema,
  expected_message_due_at: epoch, terminal_outcome: choice('paid', 'terminal_unpaid', 'exhausted'),
  due_partition: text, due_sort: text,
}, ['processing_lease', 'dispatch_lease', 'expected_message_due_at', 'terminal_outcome', 'due_partition', 'due_sort']);
export const billingRecordSchemas: Record<string, Schema> = {
  replay_checkpoint: object({ ...row, entity_type: constant('replay_checkpoint'), environment: id, replay_shard: constant(0),
    cursor: object({ PK: text, SK: text, due_partition: text, due_sort: text }), lease: leaseSchema }, ['cursor', 'lease']),
  customer: object({ ...base, entity_type: constant('customer'), SK: constant('CUSTOMER'),
    stripe_account: providerId('acct'), stripe_customer_id: providerId('cus') }),
  subscription: object({ ...base, entity_type: constant('subscription'), subscription_id: id,
    customer_id: providerId('cus'), order_id: id, term_id: id, snapshot: snapshotSchema,
    term_start: epoch, paid_through: epoch, state: choice('paid', 'expired', 'revoked'), revoked: boolean,
    payment_id: providerId('pi'), updated_at: epoch }),
  order: orderSchema,
  upgrade_quote: quoteSchema,
  credit_reservation: object({ ...base, entity_type: constant('credit_reservation'), subscription_id: id,
    source_term_id: id, source_revision: integer, quote_id: id, order_id: id, operation_id: id,
    generation: positive, state: choice('held', 'consumed', 'released'), terminal_evidence: terminalEvidence }, ['terminal_evidence']),
  consumed_credit: object({ ...base, entity_type: constant('consumed_credit'), source_term_id: id,
    quote_id: id, order_id: id, payment_id: providerId('pi'), credit_minor: integer, currency,
    new_term_id: id, consumed_at: epoch }),
  reconciliation_work: workSchema,
  billing_lease: object({ ...base, entity_type: constant('billing_lease'), SK: constant('LEASE'), lease: leaseSchema }),
  provider_lookup: object({ ...base, entity_type: constant('provider_lookup'), SK: constant('OWNER'),
    stripe_account: providerId('acct'), object_type: choice('customer', 'checkout_session', 'payment_intent'),
    object_id: text, order_id: id }),
  event: object({ ...base, entity_type: constant('event'), SK: constant('EVENT'), stripe_account: providerId('acct'),
    event_id: providerId('evt'), payload_digest: digest, state: choice('pending', 'committed', 'repair_required'),
    lease: leaseSchema, committed_revision: integer, observed_at: epoch }, ['lease', 'committed_revision']),
  decision_history: object({ ...base, entity_type: constant('decision_history'), notification_id: id,
    order_id: id, term_id: id, decision_revision: integer, allowed: boolean, snapshot: snapshotSchema,
    valid_until: epoch, created_at: epoch }),
  entitlement: entitlementSchema,
};
const validators = new Map(Object.entries(billingRecordSchemas).map(([kind, schema]) => [kind, compile(schema)]));
const field = (value: Record<string, unknown>, key: string): string => value[key] as string;
const number = (value: Record<string, unknown>, key: string): number => value[key] as number;
const invalid = (): never => { throw new Error('invalid_billing_record'); };

/** Stable digest over the immutable quote fields; mutable state/revision/key fields are excluded. */
export function quoteDigest(value: Record<string, unknown>): string {
  const keys = ['quote_id', 'subscription_id', 'source_term_id', 'source_revision', 'source_start', 'source_end',
    'eligible_old_value_minor', 'quote_at', 'expires_at', 'source_tier_order', 'target_tier_order', 'target',
    'full_amount_minor', 'credit_minor', 'payable_minor', 'currency', 'environment', 'identity'];
  return createHash('sha256').update(canonicalJson(Object.fromEntries(keys.map(key => [key, value[key]])))).digest('hex');
}
export function validateBillingRecord(input: unknown, environment: string): void {
  if (!input || typeof input !== 'object') invalid();
  const value = input as Record<string, unknown>;
  const validate = validators.get(field(value, 'entity_type'));
  if (!validate) throw new Error('invalid_billing_record');
  validate(value);
  if (value.environment !== environment) invalid();
  const kind = field(value, 'entity_type');
  if (kind === 'replay_checkpoint') {
    if (value.PK !== `ENV#${environment}#REPLAY#0` || value.SK !== 'CHECKPOINT') invalid();
    const cursor = value.cursor as Record<string, string> | undefined;
    const identityPrefix = `ENV#${environment}#IDENTITY#`;
    if (cursor && (!cursor.PK!.startsWith(identityPrefix) || !sha256HexPattern.test(cursor.PK!.slice(identityPrefix.length)) ||
        !/^WORK#[A-Za-z0-9_-]+$/.test(cursor.SK!) || cursor.due_partition !== `ENV#${environment}#DUE#0` ||
        !new RegExp(`^[0-9]{12}#${cursor.SK!.slice(5)}$`).test(cursor.due_sort!))) invalid();
    return;
  }
  if (kind === 'entitlement') {
    if (value.PK !== identityPartition(environment, field(value, 'identity_issuer'), field(value, 'identity_subject'))) invalid();
    return;
  }
  const owner = value.identity as { issuer: string; subject: string };
  let pk = identityPartition(environment, owner.issuer, owner.subject);
  let sk: string;
  switch (kind) {
    case 'customer': sk = 'CUSTOMER'; break;
    case 'subscription': sk = `SUB#${field(value, 'subscription_id')}`; break;
    case 'order': sk = `ORDER#${field(value, 'order_id')}`; break;
    case 'upgrade_quote': sk = `UPGRADEQUOTE#${field(value, 'quote_id')}`; break;
    case 'credit_reservation': sk = `UPGRADERESERVATION#${field(value, 'subscription_id')}`; break;
    case 'consumed_credit': sk = `CREDIT#${field(value, 'source_term_id')}`; break;
    case 'reconciliation_work': sk = `WORK#${field(value, 'operation_id')}`; break;
    case 'billing_lease': sk = 'LEASE'; break;
    case 'provider_lookup': pk = `ENV#${environment}#STRIPE#${field(value, 'stripe_account')}#${field(value, 'object_type')}#${field(value, 'object_id')}`; sk = 'OWNER'; break;
    case 'event': pk = `ENV#${environment}#EVENT#${field(value, 'stripe_account')}#${field(value, 'event_id')}`; sk = 'EVENT'; break;
    case 'decision_history': sk = `HISTORY#${number(value, 'decision_revision').toString().padStart(16, '0')}`; break;
    default: return invalid();
  }
  if (value.PK !== pk || value.SK !== sk) invalid();
  const snapshot = (value.snapshot ?? value.target) as Snapshot | undefined;
  if (snapshot && snapshot.environment !== environment) invalid();
  if (kind === 'order') {
    const financial = ['quote_id', 'payable_minor', 'credit_minor'];
    if (value.intent === 'upgrade') {
      if (financial.some(key => value[key] === undefined) || number(value, 'payable_minor') + number(value, 'credit_minor') !== snapshot?.amount_minor) invalid();
    } else if (financial.some(key => value[key] !== undefined)) invalid();
  }
  if (kind === 'subscription' && (number(value, 'term_start') >= number(value, 'paid_through') ||
      (value.state === 'revoked') !== value.revoked || number(value, 'paid_through') !== termExpiry(number(value, 'term_start'), snapshot!.service_term))) invalid();
  if (kind === 'consumed_credit' && value.source_term_id === value.new_term_id) invalid();
  if (kind === 'provider_lookup') {
    const prefix = { customer: 'cus_', checkout_session: 'cs_', payment_intent: 'pi_' }[field(value, 'object_type')];
    if (!prefix || !new RegExp(`^${prefix}[A-Za-z0-9_]+$`).test(field(value, 'object_id'))) invalid();
  }
  if (kind === 'decision_history' && value.decision_revision !== value.revision) invalid();
  if (kind === 'event' && value.state === 'committed' && value.committed_revision === undefined) invalid();
  if (kind === 'credit_reservation' && value.state !== 'held') {
    const evidence = value.terminal_evidence as { outcome: string } | undefined;
    if (!evidence || evidence.outcome !== (value.state === 'consumed' ? 'paid' : 'terminal_unpaid')) invalid();
  }
  if (kind === 'upgrade_quote') validateQuote(value);
  if (kind === 'reconciliation_work') {
    if (value.due_at !== value.next_attempt_at || number(value, 'deadline') <= number(value, 'due_at') ||
        (value.state === 'pending' && (value.due_sort === undefined || value.due_partition === undefined)) ||
        (value.due_sort !== undefined && value.due_sort !== `${number(value, 'due_at').toString().padStart(12, '0')}#${field(value, 'operation_id')}`) ||
        (value.due_partition !== undefined && !new RegExp(`^ENV#${environment}#DUE#[0-9]+$`).test(field(value, 'due_partition'))) ||
        (value.dispatch_status === 'sent' && value.expected_message_due_at === undefined) ||
        (value.dispatch_status === 'claimed' && value.dispatch_lease === undefined) ||
        (value.state === 'complete' && value.terminal_outcome === undefined)) invalid();
  }
}
function validateQuote(value: Record<string, unknown>): void {
  const start = number(value, 'source_start'), end = number(value, 'source_end'), at = number(value, 'quote_at');
  if (start >= end || at < start || at >= end || number(value, 'expires_at') <= at ||
      number(value, 'source_tier_order') >= number(value, 'target_tier_order')) invalid();
  // BigInt avoids precision loss for otherwise-valid integer minor-unit values.
  const credit = BigInt(number(value, 'eligible_old_value_minor')) * BigInt(end - at) / BigInt(end - start);
  const full = number(value, 'full_amount_minor'), target = value.target as Snapshot;
  if (BigInt(number(value, 'credit_minor')) !== credit || full !== target.amount_minor || value.currency !== target.currency ||
      number(value, 'payable_minor') !== full - number(value, 'credit_minor') || value.quote_digest !== quoteDigest(value)) invalid();
}
