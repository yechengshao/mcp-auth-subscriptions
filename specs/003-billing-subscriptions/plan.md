# Plan 003: Billing and Subscriptions

**Updated**: 2026-11-05 · **Status**: Planned; implementation and live acceptance pending. [Spec](spec.md) · [Tasks](tasks.md)

## Architecture

Use a separate TypeScript/Node.js ARM64 Lambda package, Express REST-v1 adapter and direct IAM-operation dispatcher. Match spec 002's pinned Node.js LTS, strict NodeNext, npm lockfile, typecheck/build and emitted Node test suites. Stripe SDK and billing state stay outside access/MCP. Export app, adapter and native dispatcher separately; only HTTP events enter Express. Mount Stripe raw-body verification before JSON parsing and preserve base64 bytes through the adapter.

Access owns browser sessions, CSRF, OAuth state and final code redirect. Billing owns approved catalog, own-account orders, Stripe integration, durable events, subscriptions and entitlement/outbox commits. The [physical interface](contracts/storage-operations.md) owns keys, operation envelopes, leases and recovery. The [checkout contract](contracts/checkout-onboarding.md) owns behavioral rules; spec 002's endpoint contract owns HTTP paths.

## Components

| Artifact | Responsibility |
|---|---|
| `billing/` | Isolated package, provider adapter, eligibility reducer, transaction repository, order operations, webhook and bounded reconciliation dispatcher |
| `infra/billing/storage.yaml` | Retained billing-state, entitlement and activation-outbox tables/indexes/streams; no Cognito/gateway/function dependency |
| `infra/billing/runtime.yaml` | Billing function/version/alias/logs, scoped storage/Stripe-secret access and configuration; no gateway attachments |
| `infra/billing/publication.yaml` | Independent ECR/protected OIDC publication bootstrap without access/MCP publishing rights |
| `scripts/verify_billing.ts` | Redacted local/live evidence, selected tests, schemas and artifact identity; no provisioning or charge side effects |

Expose separate entitlement and outbox tables so access cannot read payment/customer/event records. Strong base-table reads decide eligibility; indexes are scheduling/discovery hints. Conditional transactions commit projection, subscription summary, event outcome and outbox together. Never hold a request through human payment. Access-owned stream handlers and schedules invoke short recovery operations using exact billing alias permissions; billing grants no orchestration rights and never writes access stores.

Technical lifecycle cases are mapped in the [subscription lifecycle contract](contracts/subscription-lifecycle.md).

## Policy and secrets

Apply spec FR-007: active paid/no grace, no unpaid trial or past-due eligibility; cancelling renewal retains paid-through access, immediate eligibility revocation blocks issuance/refresh under access token bounds. Final approved price/catalog mapping and account/region are operator inputs, not fabricated defaults. Persist paid-through from verified paid provider state, never merely a Checkout browser return or an unpaid future subscription period.

Use test mode for fixtures/future authorized acceptance; reject mixed environment/account/customer/price mappings. Pin Stripe SDK and explicit API/webhook version together at implementation after compatibility tests, not an unverified version guess. Store Stripe API/webhook secrets in scoped Parameter Store SecureStrings, cache in billing memory with bounded refresh, and fail closed on unavailable/invalid configuration; no secret values in templates, images, logs or evidence. No service JWT private-key access.

Hosted portal is disabled until its sessions/actions can meet FR-009's current-paid gate, including saved links; implement guarded own-account management operations otherwise. Refund/dispute automation, pricing/tax design and strict usage-credit billing remain outside this feature.

## Delivery and validation

1. Finalize/test storage-operation schemas and catalog/state reducers with fixtures.
2. Implement idempotent orders/provider adapter, verified webhook commit, consistent entitlement reads and bounded recovery.
3. Package/test isolated ARM64 runtime; prepare retained storage/runtime/publication IaC without live deployment.
4. Validate access handoff with shared schema fixtures, then independent CI/evidence and local full journey.
5. Only with separately authorized prerequisites, validate test-mode Stripe/host/stream/schedule behavior; leave live outcomes not_run otherwise.

Tests cover ten duplicate/concurrent deliveries, out-of-order provider events, crash before/after Stripe effects or DynamoDB commits, expired leases/fencing, missed streams, unsigned/raw-body tampering, cross-account/order/price attacks, renewal/cancellation/revocation, unavailable state, expired OAuth/closed browser and no duplicate charge. Typecheck/build, packaged adapter tests, IaC lint and current-run test counts are required. Mocks cannot prove live payment or host interoperability.

Retain records across release/rollback; support existing schema versions. Explicit operator retention and recovery budgets must be configured before deployment; no TTL deletion of entitlement/history/outbox while consumers may need recovery. Preserve spec/task IDs and report prepared artifacts separately from deployed resources.
