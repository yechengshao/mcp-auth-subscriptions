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
| plan display | name, description, currency, amount_minor, interval and interval_count matching the approved Stripe price; integer minor units, no guessed prices |
| plan sale state | enabled_for_purchase and supported purchase/renewal actions; disabling sale does not revoke existing paid entitlement |
| plan Stripe mapping | Approved product_id, price_id, test/live mode; server-only provider references |
| plan usage mapping | Exactly one usage_plan_id plus rest_api_id and stage for this catalog entry/environment; optional declared rate/burst/quota metadata must match provisioned AWS configuration |

Multiple subscribers share a plan entry/usage-plan definition, never an API key. Distinct billing plans may map to the same usage plan unless a later explicit catalog policy forbids it; this decision does not invent a unique usage plan per billing plan. No default tier fallback. Parameter Store holds definitions/references and their mapping, not the Stripe/API Gateway resources themselves.

## Runtime read, display and purchase

Billing reads/caches the validated shared catalog for listPlans and Checkout. Access can read the same document for configuration validation or approved onboarding needs; do not maintain an independent second plan catalog. Both receive exact-parameter ssm:GetParameter, with no PutParameter/DeleteParameter or account-wide discovery. The browser receives only customer-facing plan fields and catalog_version from the backend; never reads AWS directly or sees internal AWS/Stripe resource references.

Use per-Lambda memory cache, maximum age 60 seconds, three-second fetch deadline, and deduplicated concurrent loads. Refresh on cache expiry; validate the full document and actual SSM/catalog version pair before use. Missing/malformed/unavailable expired-cache catalog blocks new listing/Checkout/provisioning that needs a new selection with a retryable configuration result; no indefinite stale fallback. A displayed quote carries its catalog version. createCheckout revalidates the selected enabled plan/version before recording the order; if a changed price/mapping invalidates that quote, return catalog_changed and require redisplay/confirmation, never silently charge a different plan/price.

Before the Stripe side effect, persist an immutable server-validated order snapshot: plan_id, catalog_version/SSM version, selected price/product, amount/currency/interval, environment and resolved usage_plan_id/rest_api_id/stage. Browser-supplied price, resource ID or mapping is never authority. Existing pending intent retries reuse that snapshot and Stripe idempotency identity rather than rebuilding from the latest catalog. Retain snapshots beyond SSM history pruning so verified late webhooks/reconciliation can resolve purchases without the latest parameter.

## Verified payment and subscriber state

Billing validates provider payment/ownership against the order snapshot, then atomically records subscription, entitlement and decision history. Subscription and entitlement carry plan_id, catalog_version, eligibility, valid_until/revision and the resolved nonsecret usage mapping snapshot. No native subscriber API key enters billing tables or catalog. Access reads that entitlement snapshot and conditionally creates/reuses the subscriber key in its own binding table.

The binding stores subscriber/environment, plan_id, catalog_version, entitlement_revision, usage_plan_id, rest_api_id, stage, native key ID/value under existing scoped encrypted access, and readiness/provisioning lease state. It must match the current trusted entitlement snapshot before issuance/refresh. A missing snapshot is a configuration/migration error; do not silently map historical purchases through today's catalog. Binding preparation remains bounded, request-driven and idempotent, with no activation queue.

For active subscribers with a matching ready binding, login/issuance/refresh reads current DynamoDB grant/entitlement/binding state without fetching the latest plan catalog or listing AWS usage plans. JWT signing-key retrieval/cache is separate and unchanged. New binding after loss can use the purchased mapping snapshot; native association APIs may still need to verify/create the association. Database-only eligibility decisions do not mean no signing/management dependency calls ever occur.

## Updates and rollout validation

Publish validated new catalog versions to change future offerings; cache refresh makes them visible within the stated bound. Validate each enabled entry's Stripe amount/currency/interval/mode and actual API Gateway account/API/stage/usage-plan existence/association/limits in deployment checks before enabling purchase. Unit fixtures cannot prove live resource correctness. Update resources first, publish catalog second, and retain old references for existing subscriptions, pending orders and rollback.

Catalog edits do not rewrite purchased snapshots, automatically change existing subscription prices or revoke eligibility. Renewals retain the subscription's pinned price/mapping policy unless an explicit tested migration changes it. Paid validity and revisions still advance from verified provider events. Plan upgrades/downgrades/proration require separate explicit action policy and migration, never an unreviewed parameter edit.

Editing a shared API Gateway usage plan's actual limits affects every key associated with it, even if DynamoDB snapshots are unchanged. To preserve old purchased limit behavior, provision a new usage-plan version and migrate only explicitly selected subscriptions/bindings. Changing a catalog reference or declared limit does not itself update AWS limits. Do not delete/reuse resource IDs while old purchases reference them. Record catalog and migration versions in redacted evidence without publishing subscriber keys.

B001/B003/B005/B010 and access T014/T017 validate schema/cache/IAM, display filtering, missing mapping, disabled sale, quote change, old-order retries, late payment after catalog replacement, current-ready-binding login during SSM outage, revision mismatch, shared-plan limit changes and rollback. Integration/deployment evidence validates real referenced resources separately; no live configuration is performed by this document.
