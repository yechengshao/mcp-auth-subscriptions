# Contract: Shared Parameter Store Plan Catalog

**Status**: Planned storage and mapping decision; no parameters, Stripe objects or usage plans are deployed.

**Amendment (2026-11-25)**: the approved authority for plans, prices and their usage-plan mapping is Stripe, as described in [Stripe authority amendment](#stripe-authority-amendment-2026-11-25). Where the sections below describe the SSM catalog as the authority, that amendment supersedes them. This contract owns shared catalog/version/snapshot behavior; eligibility policy remains spec FR-007, subscription keys remain the storage contract, and key provisioning belongs to access.

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

## Closed service-term model

The [service-term JSON Schema](service-term.schema.json) is authoritative, with [validation/calendar vectors](service-term.examples.json): object fields unit, integer count and time_semantics only. Supported units are day (1–3650, utc_fixed_days), month (1–120, utc_calendar_clamp), year (1–10, utc_calendar_clamp). These are technical validation bounds, not actual sellable offers; catalog enables explicit choices only. Reject fractional/zero/negative/excess counts, mismatched policies, free-form time expressions and extra properties.

Start at verified successful-payment UTC epoch seconds, preserving UTC time-of-day; valid_until is exclusive. Days add count*86400 seconds. Months add the entire count directly to the ORIGINAL UTC year/month then clamp original day to the target month's last day; do not iteratively add one month and accumulate drift. Years add count to original year and clamp invalid leap-day to February 28. No local DST, implicit 30-day month, rounding up or webhook receipt timestamp. Examples: January 31 plus one month → February 28 (29 in leap year); January 31 plus two months → March 31; February 29 2024 plus one year → February 28 2025, with unchanged UTC clock time. Numeric expiry must fit supported UTC/date arithmetic; invalid input cannot be sold or charged.

## Runtime read, display and purchase

Billing reads/caches the validated shared catalog for listPlans and Checkout. Access can read the same document for configuration validation or approved onboarding needs; do not maintain an independent second plan catalog. Both receive exact-parameter ssm:GetParameter, with no PutParameter/DeleteParameter or account-wide discovery. The browser receives only customer-facing plan fields and catalog_version from the backend; never reads AWS directly or sees internal AWS/Stripe resource references.

Use per-Lambda memory cache, maximum age 60 seconds, three-second fetch deadline, and deduplicated concurrent loads. Refresh on cache expiry; validate the full document and actual SSM/catalog version pair before use. Missing/malformed/unavailable expired-cache catalog blocks new listing/Checkout/provisioning that needs a new selection with a retryable configuration result; no indefinite stale fallback. A displayed quote carries its catalog version. createCheckout revalidates the selected enabled plan/duration/version before recording the order; if a changed price/mapping invalidates that quote, return outcome=conflict with error_code=catalog_changed and require redisplay/confirmation, never silently charge a different plan/price.

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

## Mapping source and publication (2026-11-25)

The mapping from a billing plan to AWS and Stripe resources is built from the owners of each value, not typed by hand. The server catalog remains the only authority for checkout, entitlements and access provisioning; Stripe metadata is a verification record and never a runtime source.

Order of provisioning:

1. **Usage plans** are defined in `infra/access/gateway.yaml`, one `AWS::ApiGateway::UsagePlan` per sellable tier with its rate, burst and quota in code. The same template writes each plan ID to `/mcp/<env>/access-api/<plan-name>` (the basic plan keeps `/mcp/<env>/access-api/usage-plan-id`). A plan that is not defined in the template is not published and not sellable.
2. **Stripe prices** are created in the target account after the usage plan exists. Each price's metadata records `plan_id`, `duration_option_id`, `environment`, and the usage plan ID read from SSM. Stripe prices cannot change amount or currency, so the binding stays fixed once created. Stripe objects cannot be created from CloudFormation; the IDs are the only manual input.
3. **Publication** reads the usage plan IDs from SSM and the price and product IDs from Stripe, verifies that each price's metadata matches its catalog entry, and only then assembles the catalog document. A mismatch, a missing price, a live-mode price in a test environment, or a usage plan that is not on the deployed REST API and stage fails the publish. The assembled document is passed to `infra/billing/catalog.yaml` as `CatalogJson` and becomes a new `catalog_version`.

Consumers are unchanged: billing reads the catalog document for listing and checkout, and access reads the entitlement snapshot. Neither reads Stripe metadata or usage plan parameters at request time. The catalog template stores the approved document and does not perform the mapping.

Rules that keep the mapping maintainable:
- Add a tier by adding its usage plan to the gateway template, deploying the gateway, creating its prices with the metadata above, then publishing a new catalog version. No existing entry is edited in place.
- Retire a tier by setting `enabled_for_purchase` to false in a new catalog version. Existing entitlements keep their snapshot.
- Test and production use separate Stripe accounts, usage plan parameters, and catalog parameters. Production values are never created or published from a test run.


## Stripe authority amendment (2026-11-25)

Stripe is the authority for sellable plans, durations, prices and their usage-plan mapping. The shared SSM catalog document, its `catalog_version` and the `infra/billing/catalog.yaml` template are retired as a runtime source. The server still validates every value it uses, and AWS usage plans remain owned by the gateway stack.

### Structure in Stripe

- One active Stripe **Product** per billing plan. Product metadata: `plan_id`, `tier_order`, `enabled_for_purchase`, `actions` (comma list), `environment`.
- One one-time **Price** per duration option. Price metadata: `plan_id`, `duration_option_id`, `usage_plan_id`, `rest_api_id`, `stage`, `service_term` (unit, count, `time_semantics`), `environment`, `enabled_for_purchase`. `unit_amount` and `currency` are the amount; `mode` is `payment`.
- Metadata is the only place these values live. Environment is the Stripe account plus `livemode`; a test-mode price can never be used in a live environment, and the reverse.

### Immutability rule

Stripe prices cannot change amount or currency, so each price is an immutable version. A price's metadata is never edited once the price has been used for a purchase or quote. To change a mapping, create a new price with the new metadata, deactivate the old one, and leave the old one attached to existing orders. A metadata edit on a price that is referenced by an order is a configuration error. Enable Stripe audit logging and limit dashboard write access to the billing operator role.

### Read path

- **Listing (`listPlans`)** lists active products and their active prices, then returns the customer-facing fields only. Entries whose metadata is incomplete, mixed-environment, or whose usage plan is not on the deployed REST API and stage are excluded and recorded as a sanitized configuration event; they are never shown. A valid plan with no valid price is not listed.
- Stripe reads use a per-Lambda memory cache of at most 60 seconds, a three-second deadline, and deduplicated concurrent loads. An expired cache with a failed refresh returns a retryable configuration result, not stale data.
- **Quote** carries the price ID and a digest of its metadata and amount, not the whole catalog version.
- **Checkout (`createCheckout`)** retrieves the exact price by ID (no listing), recomputes the digest, and compares it with the quote. A changed price or digest returns `conflict` with `error_code=catalog_changed`; the user must confirm again. The order snapshot stores the price ID, amount, currency, service term, usage plan, REST API, stage and the digest. Retries reuse that snapshot and the Stripe idempotency key.

### Entitlements and access

Entitlements and bindings keep the snapshot model from above: the purchase-time mapping is copied into the entitlement, and access provisions against that snapshot. Access never reads Stripe or the catalog. Renewals and upgrades use the same price-lookup and digest rules.

### Operator flow

1. The gateway stack deploys the usage plan and publishes its ID to SSM.
2. The operator creates the Stripe product and price with the metadata above, in the environment's account, and sets `enabled_for_purchase` only after the verification check passes.
3. A read-only verification command lists the Stripe objects, checks each usage plan on the deployed REST API and stage, checks `livemode` against the environment, and fails on any mismatch. It makes no Stripe writes.

### Superseded by this amendment

- The SSM catalog parameter as the authority, its `catalog_version` and its 4096-character limit.
- The publish-time catalog assembly described in "Mapping source and publication".
- The catalog template `infra/billing/catalog.yaml` is no longer deployed. Its removal is a follow-up change.

### Implementation status (2026-11-25)

- Implemented in code: `billing/adapters/stripe-catalog.ts` builds the catalog from active Stripe products and one-time prices in the environment's mode. It excludes incomplete, mixed-mode, other-environment and ambiguous entries, and refuses a release with no sellable plan. `StripeAdapter.catalogObjects` reads both lists with pagination bounded by `max_pages`. The handler reads the catalog through the existing cache (60 s maximum age, 3 s fetch deadline), and `BILLING_CATALOG_PARAMETER` is no longer required. Tests: `tests/billing/stripe_catalog.test.ts`.
- Deviation kept for now: `catalog_version` is a digest of the whole projection, not a digest per price. Any change to any plan therefore invalidates existing quotes, which is safe but broader than the per-price rule above.
- Naming kept for now: the snapshot's `ssm_version` field carries the newest Stripe `created` timestamp of the objects used.
- Not yet done: removing `infra/billing/catalog.yaml` and the catalog env/IAM from `infra/billing/runtime.yaml`, the read-only Stripe verification command, and a live check of listing latency against the 3 s fetch deadline with many objects.
