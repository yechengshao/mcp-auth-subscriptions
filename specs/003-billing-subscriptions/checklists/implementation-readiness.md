# Access/Billing Implementation Readiness

**Status**: Design reviewed; B001 contract foundation complete locally. Reviewed-decision checkmarks describe design agreement; implementation-gate checkmarks require the cited local evidence and never imply live interoperability or deployment.

## Reviewed decisions

- [x] Four separate functions: MCP, access HTTP/provisioning, authorizer and billing HTTP/native/SQS/replay.
- [x] Shared versioned Parameter Store catalog contains tiers, allowed durations, one-time Stripe prices and usage mappings; orders retain immutable selected snapshots.
- [x] First purchase and manual renewal use explicit one-time Checkout; no automatic/off-session renewal charge.
- [x] Paid upgrades start a new selected term after verified payment and apply an idempotent unused-term credit; old entitlement remains while payment is pending.
- [x] Self-service downgrades/cancellations/refunds are disabled; financial issues and nonpositive/ambiguous upgrade quotes show configured support email rather than automated adjustment.
- [x] Billing verifies payment via webhook/reconciliation and persists durable payment work before delayed queue delivery; only billing has SQS/Pipe/replay recovery.
- [x] Access binding setup is bounded/request-driven with no activation queue; success-response plus conditional persistence is configured readiness, without a propagation probe.
- [x] Paid users with incomplete setup never return to purchase; AWS setup errors preserve payment and provide safe retry/support guidance.
- [x] Access JWTs include signed usageIdentifierKey, expire within one hour/paid-through, and are checked by a datastore-free authorizer; refresh rotates with replay rejection and term-bound expiry.
- [x] Three tables are planned: AccessState, BillingState including decision history, and separate BillingEntitlements; per-record TTL never removes persistent bindings/identity or paid financial history.
- [x] Signing uses a cached Parameter Store SecureString and local RS256; observability uses economical CloudWatch/X-Ray defaults with credential redaction.
- [x] Constitution requires bounded, idempotent, resumable work and recovery of uncertain effects.

The [analysis recheck](../../analysis-report.md#resolution-and-recheck) resolves six planning findings; the subsequent [consolidated-plan review](../../analysis-report.md#post-consolidation-plan-review) validates the three-table baseline. Runtime acceptance remains pending.

## First implementation gates — partially started

The [local contract foundation](../../../billing/contracts/README.md) implements initial catalog/message/selected-record validation, synthetic boundary fixtures and UTC term calculation. Record coverage, operation-result schemas, budget checks and injected-loader cache tests now pass; real billing transactions, provider adapters and runtime composition are implemented locally; deployed IAM and live integration remain pending.

- [x] B001: machine-validating schemas and valid/invalid fixtures for catalog, paid terms, upgrade quotes, billing records/envelopes and queue references.
- [ ] T001/T014/T022: boundary tests and access-schema/atomic-update fixtures using the access storage contract, not an invented alternate model.
- [x] B003: tested paid-term calculations, minor-unit credit rounding and upgrade-eligibility policy; ambiguous taxes/fees/refund-credit valuation routes to support, not an unverified charge.
- [ ] Pin compatible Node/TypeScript/Stripe versions and install isolated lockfile-backed packages; development is local, non-provisioning and uses generated test credentials.
- [ ] Enforce quoted catalog/source revisions, stable effect identity, exact ownership/expiry/replay guards and no duplicate payment/key/credit effects in meaningful failing/passing tests.
- [ ] Validate both task dependency graphs and actual implemented prerequisite artifacts before proceeding to consumers; mocks do not finalize a missing contract or satisfy live checks.

Start with B001 plus access boundary/schema fixtures. Billing storage/policy adapters precede dependent access onboarding, while isolated authorizer tests can use the finalized token contract. B012 waits for actual access handlers; full integration must not become a prerequisite for the billing contracts it consumes. Billing handler/adapters and prepared storage/runtime templates now exist; access handlers, publication and live acceptance remain pending. See the setup guide for current evidence.

## Production/operator inputs — not blockers to schema development

- [ ] Approved tier names/order, offered durations and exact term-time semantics, currencies/prices and actual Stripe/API Gateway references; no placeholder offer can be sold.
- [ ] Support contact, approved account/region/stage, registered Cognito/AI callbacks and working discovery/domain mapping.
- [ ] Signing/catalog/Stripe parameter paths and secure values, role/resource grants, queue/retry/lease/replay/retention budgets and alarm destinations.
- [ ] Explicit upgrade-credit financial rules for any quote that cannot be calculated unambiguously from stored paid records; otherwise retain support_required and leave that case disabled.
- [ ] Separately authorized live test-mode webhook/queue/IAM/tracing/cutover acceptance, with no real charge or unsupported deployment assumption.
- [ ] Actual ChatGPT/Claude expiry, invalid_grant and reconnect/manual-renewal UI: run the [saved acceptance reminder](../../002-authentication-api-access/checklists/manual-renewal-acceptance.md) per host; do not assume automatic redirects.

## Release evidence

Typecheck/build/emitted tests, packaged handlers, IaC/redaction checks and meaningful current-run counts are required when implemented. Keep passed/failed/skipped/unavailable/not_run distinct. Billing support agents' manual refund procedures are outside application implementation; the app must not execute refunds. Cloud publication, charge/refund, email or alarm notification require their own authorization; a planning review does not provide it.

[Access plan](../../002-authentication-api-access/plan.md) · [Billing plan](../plan.md) · [Access storage](../../002-authentication-api-access/contracts/access-storage.md) · [Billing interfaces](../contracts/storage-operations.md)


## Monitoring foundation

- [x] Local Node telemetry and prepared log/policy/sampling/dashboard/alarm templates, with fake-handler redaction/context tests.
- [ ] Finish access HTTP wrappers (billing and authorizer are wired) and dependency clients, emit transitions/metrics only at verified commit points, and merge component role/environment/stage settings.
- [ ] Supply monthly budget/alert destinations, exact resource identities and alarm thresholds, then separately validate actual CloudWatch/X-Ray/ARM64 delivery.

See [implementation scope](../../../observability/README.md); no monitoring deployment or notification has run.

Billing runtime evidence: [implementation and guide](../../../docs/billing-setup.md). B004–B009 have local adapter/handler tests; this does not check off operator inputs, host journeys or live telemetry.
