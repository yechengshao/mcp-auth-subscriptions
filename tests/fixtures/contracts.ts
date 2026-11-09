/** Synthetic examples only: no deployed resources, credentials, prices or sellable offers. */
import { identityPartition } from '../../billing/contracts/validate.js';
export const now = 1800000000;
export const environment = 'test';
export const identity = { issuer: 'https://cognito.example.invalid/pool', subject: 'synthetic-user' };
export const PK = identityPartition(environment, identity.issuer, identity.subject);
export const scope = { environment, aws_account_id: '000000000000', region: 'us-east-1', stripe_account: 'acct_fixture' };
export const service_term = { unit: 'day', count: 3, time_semantics: 'utc_fixed_days' };
export const usage_mapping = { usage_plan_id: 'fixture_usage', rest_api_id: 'fixture_rest', stage: 'test' };
export const catalog = {
  schema_version: 1, catalog_version: 'fixture_v1', ...scope,
  plans: { basic: {
    tier_order: 1, display: { name: 'Fixture basic', description: 'Not a real offer' },
    enabled_for_purchase: true, actions: ['purchase', 'renewal', 'upgrade'], usage_mapping,
    duration_options: { short: { enabled_for_purchase: true, service_term, amount_minor: 1234,
      currency: 'usd', product_id: 'prod_fixture', price_id: 'price_fixture', mode: 'payment', label: 'Fixture three days' } },
  } },
};
export const entitlement = {
  PK, SK: 'ENTITLEMENT', entity_type: 'entitlement', schema_version: 1, revision: 1,
  environment, identity_issuer: identity.issuer, identity_subject: identity.subject,
  allowed: true, plan_id: 'basic', duration_option_id: 'short', service_term,
  catalog_version: 'fixture_v1', ssm_version: 1, usage_mapping, valid_until: now + 5000, updated_at: now,
};
export const session = {
  PK: `ENV#test#SESSION#${'a'.repeat(64)}`, SK: 'SESSION', schema_version: 1,
  entity_type: 'session', revision: 1, environment, purpose: 'management', tx_id: 'tx_fixture',
  authentication_stage: 'identity_verified', identity, subscriber_id: 'subscriber_fixture',
  csrf_digest: 'b'.repeat(64), created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400,
};
export const transaction = {
  PK: 'ENV#test#TX#tx_fixture', SK: 'STATE', schema_version: 1, entity_type: 'transaction', revision: 1,
  environment, purpose: 'management', local_destination: '/billing', phase: 'identity_verified', identity, subscriber_id: 'subscriber_fixture',
  created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400,
};
export const message = {
  schema_version: 1, kind: 'reconcile_payment', message_type: 'run', generation: 1,
  environment, durable_record_key: { PK, SK: 'WORK#work_fixture' }, operation_id: 'work_fixture', correlation_id: 'corr_fixture',
};
export const operation = { schema_version: 1, operation: 'listPlans', environment,
  correlation_id: 'corr_fixture', idempotency_key: 'intent_fixture', identity, input: {} };
