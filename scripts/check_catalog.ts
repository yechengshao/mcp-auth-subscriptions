/**
 * Pre-deploy catalog check. It validates a catalog file against the shared schema for one exact deployment scope,
 * then refuses any catalog that could sell a placeholder, fixture or zero-amount offer. Output carries fixed codes
 * only and never echoes catalog values, so nothing sensitive or customer-facing is printed.
 */
import { readFileSync } from 'node:fs';
import { validateCatalog, type Scope } from '../billing/contracts/validate.js';

const placeholder = /REPLACE|PLACEHOLDER|FIXTURE|example|000000000000|acct_ME|\bprice_fixture\b|\bprod_fixture\b/i;

export interface CatalogCheck { ok: boolean; codes: string[] }

/** Returns fixed codes for every reason the catalog cannot be offered for sale. */
export function checkCatalog(input: unknown, scope: Scope): CatalogCheck {
  let catalog;
  try { catalog = validateCatalog(input, scope); }
  catch (error) {
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'invalid_catalog';
    return { ok: false, codes: [code] };
  }
  const codes = new Set<string>();
  const sellable = Object.values(catalog.plans).filter(plan => plan.enabled_for_purchase);
  if (!sellable.length) codes.add('no_enabled_plan');
  if (placeholder.test(catalog.catalog_version)) codes.add('placeholder_catalog_version');
  if (placeholder.test(catalog.stripe_account)) codes.add('placeholder_stripe_account');
  // Placeholders are refused even in disabled entries, so a draft cannot slip through by being switched off.
  for (const plan of Object.values(catalog.plans)) {
    if (placeholder.test(plan.display.name) || placeholder.test(plan.display.description)) codes.add('placeholder_display_text');
    if (placeholder.test(plan.usage_mapping.usage_plan_id) || placeholder.test(plan.usage_mapping.rest_api_id)) codes.add('placeholder_usage_mapping');
    for (const duration of Object.values(plan.duration_options)) {
      if (placeholder.test(duration.price_id) || placeholder.test(duration.product_id)) codes.add('placeholder_stripe_reference');
      if (placeholder.test(duration.label)) codes.add('placeholder_display_text');
      if (plan.enabled_for_purchase && duration.enabled_for_purchase && !(duration.amount_minor > 0)) codes.add('zero_amount_offer');
    }
  }
  return { ok: codes.size === 0, codes: [...codes].sort() };
}

function main() {
  const [file, environment, accountId, region, stripeAccount] = process.argv.slice(2);
  if (!file || !environment || !accountId || !region || !stripeAccount) {
    process.stderr.write('usage: check_catalog <catalog.json> <environment> <aws_account_id> <region> <stripe_account>\n');
    process.exitCode = 2;
    return;
  }
  const scope = { environment, aws_account_id: accountId, region, stripe_account: stripeAccount };
  const result = checkCatalog(JSON.parse(readFileSync(file, 'utf8')), scope);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('check_catalog.js')) main();
