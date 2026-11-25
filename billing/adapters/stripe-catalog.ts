import { createHash } from 'node:crypto';
import { canonicalJson } from '../contracts/canonical.js';
import { validateCatalog, type Catalog, type Duration, type Mapping, type Plan, type Scope, type Term } from '../contracts/validate.js';
import type { ParameterValue } from '../contracts/catalog-cache.js';

type Json = Record<string, any>;

/** Stripe objects the catalog is built from: active products and active one-time prices, both in one mode. */
export interface StripeCatalogObjects { products: Json[]; prices: Json[] }
export interface StripeCatalogRelease extends ParameterValue { value: Catalog; excluded: number }

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TERM_LIMITS: Record<Term['unit'], { min: number; max: number; semantics: Term['time_semantics'] }> = {
  day: { min: 1, max: 3650, semantics: 'utc_fixed_days' },
  month: { min: 1, max: 120, semantics: 'utc_calendar_clamp' },
  year: { min: 1, max: 10, semantics: 'utc_calendar_clamp' },
};
const ACTIONS = ['purchase', 'renewal', 'upgrade'] as const;

const flag = (value: unknown): boolean | undefined => value === 'true' ? true : value === 'false' ? false : undefined;
const id = (value: unknown): string | undefined => typeof value === 'string' && ID.test(value) ? value : undefined;
const integer = (value: unknown, min: number, max: number): number | undefined => {
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : undefined;
};

/**
 * Builds the billing catalog from Stripe objects. Stripe is the authority: a plan or price that is
 * incomplete, mixed-mode, from another environment, or internally inconsistent is excluded and counted,
 * never shown or sold. Duplicate tiers and malformed remaining values fail the whole release.
 * The version is a digest of the projection, so any change to plan, price or mapping changes it.
 */
export function stripeCatalogRelease(input: StripeCatalogObjects, scope: Scope, live: boolean): StripeCatalogRelease {
  let excluded = 0; let newest = 0;
  const note = (object: Json) => { if (Number.isSafeInteger(object.created) && object.created > newest) newest = object.created; };
  const products = new Map<string, Json>();
  for (const product of input.products) {
    if (product.active === true && product.livemode === live && typeof product.id === 'string') products.set(product.id, product);
  }

  const plans: Record<string, Plan> = {};
  const planOfProduct = new Map<string, string>();
  for (const [productId, product] of products) {
    const meta = product.metadata ?? {};
    const planId = id(meta.plan_id), tier = integer(meta.tier_order, 1, 1000);
    const enabled = flag(meta.enabled_for_purchase);
    const actions = typeof meta.actions === 'string' ? meta.actions.split(',').map((item: string): string => item.trim()) : [];
    if (!planId || tier === undefined || enabled === undefined || meta.environment !== scope.environment ||
        actions.length === 0 || !actions.every((action: string) => (ACTIONS as readonly string[]).includes(action)) || new Set(actions).size !== actions.length ||
        typeof product.name !== 'string' || !product.name) { excluded++; continue; }
    if (plans[planId]) { excluded++; continue; }
    plans[planId] = {
      tier_order: tier, display: { name: product.name, description: typeof product.description === 'string' && product.description ? product.description : product.name },
      enabled_for_purchase: enabled, actions: actions as Plan['actions'], usage_mapping: undefined as unknown as Mapping, duration_options: {},
    };
    planOfProduct.set(productId, planId);
    note(product);
  }

  const mappingOf = new Map<string, string>();
  const invalidPlans = new Set<string>();
  const ambiguous = new Set<string>();
  for (const price of input.prices) {
    const planId = typeof price.product === 'string' ? planOfProduct.get(price.product) : undefined;
    const meta = price.metadata ?? {};
    const durationId = id(meta.duration_option_id);
    const enabled = flag(meta.enabled_for_purchase);
    const unit = meta.term_unit as Term['unit'] | undefined;
    const count = integer(meta.term_count, 1, 3650);
    const usagePlan = id(meta.usage_plan_id), restApi = id(meta.rest_api_id), stage = id(meta.stage);
    const amount = Number.isSafeInteger(price.unit_amount) && price.unit_amount > 0 ? price.unit_amount : undefined;
    const currency = typeof price.currency === 'string' && /^[a-z]{3}$/.test(price.currency) ? price.currency : undefined;
    const valid = planId && durationId && enabled !== undefined && unit && TERM_LIMITS[unit] && count !== undefined &&
      count >= TERM_LIMITS[unit].min && count <= TERM_LIMITS[unit].max && meta.term_semantics === TERM_LIMITS[unit].semantics &&
      usagePlan && restApi && stage && meta.environment === scope.environment && price.type === 'one_time' && !price.recurring &&
      price.active === true && price.livemode === live && amount !== undefined && currency && typeof price.id === 'string' &&
      /^price_/.test(price.id) && typeof meta.label === 'string' && meta.label.length > 0 && meta.label.length <= 200;
    if (!valid || !planId) { excluded++; continue; }
    const plan = plans[planId]!;
    const key = `${planId}\u0000${durationId}`;
    // Two prices claiming one duration is ambiguous: neither is sold. Other durations of the plan remain.
    if (ambiguous.has(key) || plan.duration_options[durationId]) {
      ambiguous.add(key); delete plan.duration_options[durationId]; excluded++; continue;
    }
    const mapping = JSON.stringify({ usage_plan_id: usagePlan, rest_api_id: restApi, stage });
    if (mappingOf.has(planId) && mappingOf.get(planId) !== mapping) { invalidPlans.add(planId); excluded++; continue; }
    mappingOf.set(planId, mapping);
    const duration: Duration = {
      enabled_for_purchase: enabled!, service_term: { unit: unit!, count: count!, time_semantics: TERM_LIMITS[unit!].semantics },
      amount_minor: amount!, currency: currency!, product_id: products.get(price.product)!.id, price_id: price.id,
      mode: 'payment', label: meta.label,
    };
    plan.duration_options[durationId] = duration;
    note(price);
  }

  for (const [planId, plan] of Object.entries(plans)) {
    const mapping = mappingOf.get(planId);
    if (invalidPlans.has(planId) || !mapping || Object.keys(plan.duration_options).length === 0) { delete plans[planId]; excluded++; continue; }
    plan.usage_mapping = JSON.parse(mapping) as Mapping;
    if (plan.enabled_for_purchase && !Object.values(plan.duration_options).some(option => option.enabled_for_purchase)) {
      plan.enabled_for_purchase = false;
    }
  }

  const body = { schema_version: 1 as const, ...scope, plans };
  const version = createHash('sha256').update(canonicalJson(body)).digest('hex');
  const catalog = validateCatalog({ ...body, catalog_version: version }, scope);
  return { version: newest > 0 ? newest : 1, value: catalog, excluded };
}
