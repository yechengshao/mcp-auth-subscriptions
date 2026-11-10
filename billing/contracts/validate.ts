import { catalogSchema, compile, operationSchema, orderSchema, queueSchema, snapshotSchema, failureSchema } from './schemas.js';
import { identityPartition } from '../../contracts/identity.js';
import { sha256HexPattern } from '../../contracts/patterns.js';
export { validateEntitlement } from '../../contracts/entitlement.js';
export { identityKey, identityPartition } from '../../contracts/identity.js';
export interface Scope { environment: string; aws_account_id: string; region: string; stripe_account: string }
export interface Mapping { usage_plan_id: string; rest_api_id: string; stage: string }
export interface Term { unit: 'day' | 'month' | 'year'; count: number; time_semantics: 'utc_fixed_days' | 'utc_calendar_clamp' }
export interface Duration {
  enabled_for_purchase: boolean; service_term: Term; amount_minor: number; currency: string;
  product_id: string; price_id: string; mode: 'payment'; label: string;
}
export interface Plan {
  tier_order: number; display: { name: string; description: string }; enabled_for_purchase: boolean;
  actions: Array<'purchase' | 'renewal' | 'upgrade'>; usage_mapping: Mapping; duration_options: Record<string, Duration>;
}
export interface Catalog extends Scope { schema_version: 1; catalog_version: string; plans: Record<string, Plan> }
export interface Snapshot {
  plan_id: string; duration_option_id: string; catalog_version: string; ssm_version: number;
  environment: string; service_term: Term; amount_minor: number; currency: string;
  product_id: string; price_id: string; mode: 'payment'; usage_mapping: Mapping;
}
const catalogShape = compile(catalogSchema);
export function validateCatalog(input: unknown, scope: Scope): Catalog {
  catalogShape(input);
  const value = input as Catalog;
  if (Object.entries(scope).some(([key, expected]) => value[key as keyof Scope] !== expected)) throw new Error('catalog_scope_mismatch');
  const ranks = Object.values(value.plans).map(plan => plan.tier_order);
  if (new Set(ranks).size !== ranks.length) throw new Error('duplicate_tier_order');
  for (const plan of Object.values(value.plans)) {
    if (plan.enabled_for_purchase && !Object.values(plan.duration_options).some(option => option.enabled_for_purchase)) throw new Error('no_enabled_duration');
  }
  return structuredClone(value);
}
export function purchaseSnapshot(catalog: Catalog, ssmVersion: number, planId: string, durationId: string, catalogVersion: string, action: 'purchase' | 'renewal' | 'upgrade' = 'purchase'): Snapshot {
  if (catalogVersion !== catalog.catalog_version) throw new Error('catalog_changed');
  const plan = catalog.plans[planId];
  const duration = plan?.duration_options[durationId];
  if (!plan?.enabled_for_purchase || !duration?.enabled_for_purchase || !plan.actions.includes(action)) throw new Error('offer_unavailable');
  const value: Snapshot = {
    plan_id: planId, duration_option_id: durationId, catalog_version: catalogVersion, ssm_version: ssmVersion,
    environment: catalog.environment, service_term: duration.service_term, amount_minor: duration.amount_minor,
    currency: duration.currency, product_id: duration.product_id, price_id: duration.price_id,
    mode: duration.mode, usage_mapping: plan.usage_mapping,
  };
  compile(snapshotSchema)(value);
  return structuredClone(value);
}
export function publicPlans(catalog: Catalog) {
  return { catalog_version: catalog.catalog_version, plans: Object.entries(catalog.plans)
    .filter(([, plan]) => plan.enabled_for_purchase).map(([plan_id, plan]) => ({
      plan_id, ...plan.display,
      duration_options: Object.entries(plan.duration_options).filter(([, option]) => option.enabled_for_purchase)
        .map(([duration_option_id, option]) => ({ duration_option_id, label: option.label,
          service_term: structuredClone(option.service_term), amount_minor: option.amount_minor, currency: option.currency })),
    })) };
}
const queueShape = compile(queueSchema);
interface QueueMessage { environment: string; operation_id: string; durable_record_key: { PK: string; SK: string } }
export function validateQueue(input: unknown, environment: string): void {
  queueShape(input);
  const value = input as QueueMessage;
  const prefix = `ENV#${environment}#IDENTITY#`;
  if (value.environment !== environment || !value.durable_record_key.PK.startsWith(prefix) ||
      !sha256HexPattern.test(value.durable_record_key.PK.slice(prefix.length)) ||
      value.durable_record_key.SK !== `WORK#${value.operation_id}`) throw new Error('queue_reference_mismatch');
}
const orderShape = compile(orderSchema);
interface Order { PK: string; SK: string; environment: string; identity: { issuer: string; subject: string }; order_id: string; snapshot: Snapshot }
export function validateOrder(input: unknown, environment: string): void {
  orderShape(input);
  const value = input as Order;
  if (value.environment !== environment || value.snapshot.environment !== environment || value.SK !== `ORDER#${value.order_id}` ||
      value.PK !== identityPartition(environment, value.identity.issuer, value.identity.subject)) throw new Error('order_reference_mismatch');
}
const nativeShape = compile(operationSchema);
export function validateOperation(input: unknown, environment: string): void {
  nativeShape(input);
  if ((input as { environment: string }).environment !== environment) throw new Error('operation_scope_mismatch');
}
export const validateFailure = compile(failureSchema);
