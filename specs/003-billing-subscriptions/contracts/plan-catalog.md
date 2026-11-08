# Contract: Shared Parameter Store Plan Catalog

**Status**: Planned storage and mapping decision; no parameters, Stripe objects or usage plans are deployed. This contract owns shared catalog/version/snapshot behavior; eligibility policy remains spec FR-007, subscription keys remain the storage contract, and key provisioning belongs to access.

## Catalog source and schema

Use one AWS Systems Manager Parameter Store **String** JSON document per environment/account/region, with exact parameter ARN configured for access and billing. It is nonsecret configuration: never store subscriber keys, signing keys, Stripe secrets or user state here. Choose the parameter tier based on validated document size and required history; do not silently exceed AWS size/version limits. Provision approved Stripe prices and AWS usage plans before publishing a sellable catalog; deployment resolves their actual identifiers, not runtime account-wide listing.

| Field | Definition |
|---|---|
| schema_version | Integer 1; unsupported versions reject |
| catalog_version | Immutable release identifier, tracked with actual SSM parameter version; never mutate a version in place |
| environment / aws_account_id / region / stripe_account | Exact deployment scope; reject mixed test/live or account/region mappings |
| plans | Collection keyed by unique stable plan_id |
| plan tier_order | Unique integer tier precedence within the catalog; a paid self-service upgrade must target a strictly higher enabled tier, never infer rank from price/duration |
| plan display | Tier name/description and available enabled duration options with full price/currency and explicit term labels; no guessed prices or durations |
| plan sale state | enabled_for_purchase and supported purchase/renewal/strict-upgrade actions only; disabling sale does not revoke existing paid entitlement |
| plan duration_options | Collection keyed by stable duration_option_id; each has enabled_for_purchase, service_term (unit/count plus time semantics), amount_minor, currency and approved one-time Stripe product_id/price_id/mode; provider references are server-only |
| plan usage mapping | Exactly one usage_plan_id plus rest_api_id and stage for this catalog entry/environment; optional declared rate/burst/quota metadata must match provisioned AWS configuration |

Multiple subscribers share a plan entry/usage-plan definition, never an API key. Distinct billing plans may map to the same usage plan unless a later explicit catalog policy forbids it; this decision does not invent a unique usage plan per billing plan. No default tier fallback. Parameter Store holds definitions/references and their mapping, not the Stripe/API Gateway resources themselves.

Duration is selected independently of tier: the user chooses plan_id and one of its enabled duration_option_id values. Each allowed pair resolves to exactly one one-time Stripe price and snapshotted service term; no free-form timestamps, client-computed amount or arbitrary Checkout quantity. The upgrade contract alone permits server-derived net-price Checkout against an approved base offer. All duration options for a tier share its usage-plan mapping. Duration sets paid validity, not an automatic multiplier/reset of API Gateway quota periods. Exact offered lengths, discounts and prices are operator catalog inputs; none are invented here.

## Runtime read, display and purchase

Billing reads/caches the validated shared catalog for listPlans and Checkout. Access can read the same document for configuration validation or approved onboarding needs; do not maintain an independent second plan catalog. Both receive exact-parameter ssm:GetParameter, with no PutParameter/DeleteParameter or account-wide discovery. The browser receives only customer-facing plan fields and catalog_version from the backend; never reads AWS directly or sees internal AWS/Stripe resource references.

Use per-Lambda memory cache, maximum age 60 seconds, three-second fetch deadline, and deduplicated concurrent loads. Refresh on cache expiry; validate the full document and actual SSM/catalog version pair before use. Missing/malformed/unavailable expired-cache catalog blocks new listing/Checkout/provisioning that needs a new selection with a retryable configuration result; no indefinite stale fallback. A displayed quote carries its catalog version. createCheckout revalidates the selected enabled plan/duration/version before recording the order; if a changed price/mapping invalidates that quote, return catalog_changed and require redisplay/confirmation, never silently charge a different plan/price.

Before the Stripe side effect, persist an immutable server-validated order snapshot: plan_id, duration_option_id, catalog_version/SSM version, selected one-time price/product, amount/currency/service_term, environment and resolved usage_plan_id/rest_api_id/stage. Browser-supplied price, resource ID or mapping is never authority. Existing pending intent retries reuse that snapshot and Stripe idempotency identity rather than rebuilding from the latest catalog. Retain snapshots beyond SSM history pruning so verified late webhooks/reconciliation can resolve purchases without the latest parameter.

## Verified payment and subscriber state

Billing validates provider payment/ownership against the order snapshot, then atomically records subscription, entitlement and decision history. Subscription and entitlement carry plan_id, duration_option_id and purchased service_term, catalog_version, eligibility, valid_until/revision and the resolved nonsecret usage mapping snapshot. No native subscriber API key enters billing tables or catalog. Access reads that entitlement snapshot and conditionally creates/reuses the subscriber key in its own binding table.

The binding stores subscriber/environment, plan_id, catalog_version, entitlement_revision, usage_plan_id, rest_api_id, stage, native key ID/value under existing scoped encrypted access, and readiness/provisioning lease state. It must match the current trusted entitlement snapshot before issuance/refresh. A missing snapshot is a configuration/migration error; do not silently map historical purchases through today's catalog. Binding preparation remains bounded, request-driven and idempotent, with no activation queue.

For active subscribers with a matching ready binding, login/issuance/refresh reads current DynamoDB grant/entitlement/binding state without fetching the latest plan catalog or listing AWS usage plans. JWT signing-key retrieval/cache is separate and unchanged. New binding after loss can use the purchased mapping snapshot; native association APIs create/configure the association; routine read-back/probes after success are not required, while uncertain results need state reconciliation. Database-only eligibility decisions do not mean no signing/management dependency calls ever occur.

## Updates and rollout validation

Publish validated new catalog versions to change future offerings; cache refresh makes them visible within the stated bound. Validate each enabled entry's Stripe one-time amount/currency/payment mode and service-term rules and actual API Gateway account/API/stage/usage-plan existence/association/limits in deployment checks before enabling purchase. Unit fixtures cannot prove live resource correctness. Update resources first, publish catalog second, and retain old references for existing subscriptions, pending orders and rollback.

Catalog edits do not rewrite purchased snapshots, automatically change existing subscription prices or revoke eligibility. Manual expired-term renewals require a new confirmed purchase at the current enabled catalog version; no automatic charge or inherited recurring price. Paid validity and revisions still advance from verified provider events. Paid upgrades follow the [new-term credit contract](plan-upgrade.md); self-service downgrade/cancellation/refunds are disabled, and zero-payable/excess-credit requests require support, never an unreviewed parameter edit.

Editing a shared API Gateway usage plan's actual limits affects every key associated with it, even if DynamoDB snapshots are unchanged. To preserve old purchased limit behavior, provision a new usage-plan version and migrate only explicitly selected subscriptions/bindings. Changing a catalog reference or declared limit does not itself update AWS limits. Do not delete/reuse resource IDs while old purchases reference them. Record catalog and migration versions in redacted evidence without publishing subscriber keys.

B001/B003/B005/B010 and access T014/T017 validate schema/cache/IAM, display filtering, missing mapping, disabled tier/duration, forged duration/amount, wrong-tier duration choice, term-boundary calculation, quote change, old-order retries, late payment after catalog replacement, current-ready-binding login during SSM outage, revision mismatch, shared-plan limit changes and rollback. Integration/deployment evidence validates real referenced resources separately; no live configuration is performed by this document.

Paid duration, one-time Stripe mode and manual expired-user repurchase are authoritative in [manual renewal](manual-renewal.md).
