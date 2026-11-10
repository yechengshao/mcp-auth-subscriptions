# Plan 003: Billing and Subscriptions

**Updated**: 2026-11-10 · **Status**: Billing runtime/adapters locally implemented; packaging and live acceptance pending. [Spec](spec.md) · [Tasks](tasks.md)

## Architecture

Use a separate TypeScript/Node.js ARM64 Lambda package, Express REST-v1 adapter and direct native/SQS/schedule dispatcher. Match spec 002's pinned Node.js LTS, strict NodeNext, npm lockfile, typecheck/build and emitted Node test suites. Stripe SDK and billing state stay outside access/MCP; independent runtime manifests/locks pin component dependencies, while the final image copies only billing/shared modules. Export app, adapter and native dispatcher separately; only HTTP events enter Express. Mount Stripe raw-body verification before JSON parsing and preserve base64 bytes through the adapter.

Use the shared Hexagonal Architecture: `billing/handler.ts` composes dependencies; HTTP, native and queue handlers are inbound adapters; `billing/service.ts` owns use cases; and `billing/adapters/aws.ts` plus `stripe.ts` implement outbound ports. Keep payment decisions independent of Express and provider SDKs. Access reaches billing only through its scoped IAM boundary.

Access owns browser sessions, CSRF, OAuth state and final code redirect. Billing owns approved catalog, own-account orders, Stripe integration, durable events, subscriptions and entitlement/outbox commits. The [physical interface](contracts/storage-operations.md) owns keys, operation envelopes, leases and recovery. The [checkout contract](contracts/checkout-onboarding.md) owns behavioral rules; spec 002's endpoint contract owns HTTP paths.

## Components

| Artifact | Responsibility |
|---|---|
| `billing/` | Isolated package, provider adapter, eligibility reducer, transaction repository, order operations, webhook and bounded reconciliation dispatcher |
| `infra/billing/storage.yaml` | Retained BillingState (including history), BillingEntitlements and work indexes/stream; no Cognito/gateway/function dependency |
| `infra/billing/runtime.yaml` | Billing function/version/alias, scoped roles, reconciliation SQS/DLQ/Pipe/mapping/replay and telemetry-policy attachment; no gateway attachments |
| `infra/billing/release.ts` | Render distinct retained version resources for digest-pinned images |
| `infra/billing/publication.yaml` | Independent ECR/protected OIDC publication bootstrap without access/MCP publishing rights |
| `scripts/verify_billing.ts` | Redacted local/live evidence, selected tests, schemas and artifact identity; no provisioning or charge side effects |

Keep BillingEntitlements separate from BillingState (including decision history), so access cannot read payment/customer/event records; AccessState completes the three-table application inventory. Strong base-table reads decide eligibility; indexes are scheduling/discovery hints. Conditional transactions commit projection, subscription summary, event outcome and outbox together. Never hold a request through human payment. Access consistently reads entitlement on requests; only billing reconciliation work routes through its Pipe/SQS and existing-function replay; billing grants no orchestration rights and never writes access stores.

Technical lifecycle cases are mapped in the [subscription lifecycle contract](contracts/subscription-lifecycle.md).

## Policy and secrets

Apply spec FR-007: active paid/no grace, no unpaid trial or past-due eligibility; no automatic renewal/charge, manual expired-user repurchase and support-assisted current-term cancellation under the [renewal contract](contracts/manual-renewal.md); revocation follows access token bounds. Final approved price/catalog mapping and account/region are operator inputs, not fabricated defaults. Persist paid-through from verified paid provider state, never merely a Checkout browser return or an unverified future paid term.

Use test mode for fixtures/future authorized acceptance; reject mixed environment/account/customer/price mappings. SDK 23.1.0 uses explicit API/webhook version 2025-02-24.acacia with validated JSON boundaries; local compatibility tests pass, live compatibility remains unverified. Store Stripe API/webhook secrets in scoped Parameter Store SecureStrings, cache in billing memory with bounded refresh, and fail closed on unavailable/invalid configuration; no secret values in templates, images, logs or evidence. No service JWT private-key access.

Hosted portal stays disabled. Self-service management permits only positive-payment upgrades; downgrade/cancel/refund/ambiguous-credit requests display support email without application financial adjustment. Refund/dispute automation, pricing/tax design and strict usage-credit billing remain outside this feature.

Function inventory, delayed billing SQS jobs, managed routing and billing-work replay follow the access [background delivery contract](../002-authentication-api-access/contracts/background-delivery.md); total target is four Lambdas including MCP, with no dedicated recovery function.

## Delivery and validation

1. Finalize/test storage-operation schemas and catalog/state reducers with fixtures.
2. Implement idempotent orders/provider adapter, verified webhook commit, consistent entitlement reads and bounded recovery.
3. Package/test isolated ARM64 runtime; prepare retained storage/runtime/publication IaC without live deployment.
4. Validate access handoff with shared schema fixtures, then independent CI/evidence and local full journey.
5. Only with separately authorized prerequisites, validate test-mode Stripe/host/stream/schedule behavior; leave live outcomes not_run otherwise.

Tests cover ten duplicate/concurrent deliveries, out-of-order provider events, crash before/after Stripe effects or DynamoDB commits, expired leases/fencing, missed streams, unsigned/raw-body tampering, cross-account/order/price attacks, renewal/cancellation/revocation, unavailable state, expired OAuth/closed browser and no duplicate charge. Typecheck/build, packaged adapter tests, IaC lint and current-run test counts are required. Mocks cannot prove live payment or host interoperability.

Retain records across release/rollback; support existing schema versions. Explicit billing retention and recovery budgets must be configured before deployment; no TTL deletion of entitlement/history/outbox while consumers may need recovery. Preserve spec/task IDs and report prepared artifacts separately from deployed resources.

Monitoring follows the [contract](../002-authentication-api-access/contracts/observability.md); [local wrappers/templates](../../observability/README.md) are implemented, with handler/deployment wiring still pending under B010/B013.

Plan details, Stripe/usage-plan mapping and purchase snapshots follow the versioned Parameter Store [catalog contract](contracts/plan-catalog.md); existing-ready login/refresh uses DynamoDB snapshots.

The [readiness checklist](checklists/implementation-readiness.md) defines schema-first development and separate production/live gates.
