import { compile, epoch } from './contracts/schemas.js';
import { termExpiry } from './contracts/service-term.js';
import type { Snapshot } from './contracts/validate.js';
import { canonicalJson } from './contracts/canonical.js';
import { snapshotSchema } from './contracts/schemas.js';

const checkEpoch = compile(epoch);
const checkSnapshot = compile(snapshotSchema);
export interface PaidTerm {
  payment_id: string;
  starts_at: number;
  valid_until: number;
  snapshot: Snapshot;
  revoked: boolean;
}
export type Observation =
  | { kind: 'payment'; payment_id: string; verified: boolean; owned: boolean;
      status: 'paid' | 'pending' | 'failed'; paid_at: number;
      amount_minor: number; currency: string; price_id: string; mode: string }
  | { kind: 'revoke'; authorized: boolean }
  | { kind: 'navigation' | 'recurring_event' | 'support_request' };
export interface Decision {
  term: PaidTerm | null;
  changed: boolean;
  eligible: boolean;
  next: 'access' | 'select_plan' | 'payment_pending' | 'denied' | 'support_required';
}
/** Pure decision only. Callers must use verified provider reads and fenced atomic persistence. */
export function reduceLifecycle(current: PaidTerm | null, observation: Observation, snapshot: Snapshot, now: number): Decision {
  checkEpoch(now); checkSnapshot(snapshot);
  if (current) {
    checkEpoch(current.starts_at); checkEpoch(current.valid_until); checkSnapshot(current.snapshot);
    if (current.snapshot.environment !== snapshot.environment) throw new Error('term_scope_mismatch');
    if (current.valid_until !== termExpiry(current.starts_at, current.snapshot.service_term)) throw new Error('invalid_paid_interval');
  }
  let term = current ? structuredClone(current) : null;
  let changed = false;
  let next: Decision['next'] | undefined;
  if (observation.kind === 'revoke') {
    if (!observation.authorized) throw new Error('unverified_revocation');
    if (term && !term.revoked) { term.revoked = true; changed = true; }
    next = 'denied';
  } else if (observation.kind === 'payment') {
    checkEpoch(observation.paid_at);
    if (!observation.verified || !observation.owned) throw new Error('unverified_payment');
    if (observation.mode !== 'payment' || observation.price_id !== snapshot.price_id ||
        observation.currency !== snapshot.currency || observation.amount_minor !== snapshot.amount_minor) throw new Error('payment_mismatch');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(observation.payment_id)) throw new Error('invalid_payment_reference');
    if (observation.status === 'paid') {
      if (observation.paid_at > now) throw new Error('future_payment');
      if (term?.payment_id === observation.payment_id) {
        if (term.starts_at !== observation.paid_at || canonicalJson(term.snapshot) !== canonicalJson(snapshot)) throw new Error('payment_conflict');
      } else {
        // Active-term replacements require the separately priced/credited upgrade transaction.
        if (term && term.valid_until > observation.paid_at) throw new Error('active_term_conflict');
        term = { payment_id: observation.payment_id, starts_at: observation.paid_at,
          valid_until: termExpiry(observation.paid_at, snapshot.service_term), snapshot: structuredClone(snapshot), revoked: false };
        changed = true;
      }
    } else if (!term || term.revoked || term.valid_until <= now) {
      next = observation.status === 'pending' ? 'payment_pending' : 'select_plan';
    }
  } else if (observation.kind === 'support_request') next = 'support_required';
  const eligible = !!term && !term.revoked && term.starts_at <= now && now < term.valid_until;
  return { term, changed, eligible, next: next ?? (eligible ? 'access' : term?.revoked ? 'denied' : 'select_plan') };
}
