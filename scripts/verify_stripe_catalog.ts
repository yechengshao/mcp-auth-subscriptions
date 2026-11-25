/**
 * Read-only check of the Stripe plan catalog before a price is enabled for sale. It makes only GET requests
 * (the account, and active products and one-time prices), builds the same projection the billing service uses,
 * and prints fixed reason codes with Stripe object IDs. It never prints the secret key, prices, or customer data.
 *
 * usage: STRIPE_SECRET_KEY=<key from the environment, never pasted in chat> verify_stripe_catalog
 *          <environment> <aws_account_id> <region> <stripe_account> <live true|false> <rest_api_id> <stage>
 */
import { stripeCatalogRelease, type StripeCatalogRelease } from '../billing/adapters/stripe-catalog.js';
import { StripeAdapter } from '../billing/adapters/stripe.js';
import { Telemetry } from '../observability/telemetry.js';

export interface VerificationReport { ok: boolean; lines: string[] }

/** Summarizes a release for an operator: counts, then one line per excluded object. Fails if anything is excluded or nothing is sellable. */
export function summarize(release: StripeCatalogRelease): VerificationReport {
  const plans = Object.values(release.value.plans);
  const durations = plans.reduce((total, plan) => total + Object.keys(plan.duration_options).length, 0);
  const lines = [`plans=${plans.length} durations=${durations} excluded=${release.reasons.length}`];
  for (const excluded of release.reasons) lines.push(`excluded ${excluded.object} ${excluded.reason}`);
  return { ok: plans.length > 0 && release.reasons.length === 0, lines };
}

async function main(): Promise<number> {
  const [environment, accountId, region, stripeAccount, live, restApiId, stage] = process.argv.slice(2);
  const key = process.env.STRIPE_SECRET_KEY;
  if (!environment || !accountId || !region || !stripeAccount || !live || !restApiId || !stage || !key || !['true', 'false'].includes(live)) {
    process.stderr.write('usage: verify_stripe_catalog <environment> <aws_account_id> <region> <stripe_account> <live true|false> <rest_api_id> <stage> (STRIPE_SECRET_KEY in env)\n');
    return 2;
  }
  const isLive = live === 'true';
  const scope = { environment, aws_account_id: accountId, region, stripe_account: stripeAccount };
  const telemetry = new Telemetry({ service: 'billing', environment: environment as 'test', release: 'verify' }, { sink: () => undefined });
  const stripe = new StripeAdapter(async () => key, {
    account: stripeAccount, live: isLive, successUrl: 'https://example.invalid/success', cancelUrl: 'https://example.invalid/cancel', maxPages: 10,
  }, telemetry);
  try {
    const objects = await stripe.catalogObjects(10);
    const report = summarize(stripeCatalogRelease(objects, scope, isLive, { rest_api_id: restApiId, stage }));
    for (const line of report.lines) process.stdout.write(`${line}\n`);
    return report.ok ? 0 : 1;
  } catch {
    // Fixed code only: provider and transport errors can echo request data, so they are never printed.
    process.stdout.write('verification_failed\n');
    return 1;
  }
}

if (process.argv[1]?.endsWith('verify_stripe_catalog.js')) void main().then(code => { process.exitCode = code; });
