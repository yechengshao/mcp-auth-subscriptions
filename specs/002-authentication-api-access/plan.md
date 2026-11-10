# Plan 002: Authentication and API Access

**Updated**: 2026-11-10 · **Status**: Core Node.js Access flows implemented locally; 22 tasks remain unchecked until their contract, dependency, packaging and acceptance criteria are complete. [Spec](spec.md) · [Tasks](tasks.md)

## Architecture

Cognito human PKCE → billing plan/order/Stripe → committed entitlement → native usage binding → OAuth code exchange → short-lived service bearer. Existing eligible subscribers skip purchase. Node.js application logic coordinates persisted DynamoDB transitions; short access requests and billing payment recovery advance the flow without Step Functions. The REQUEST authorizer validates JWTs synchronously. MCP remains authentication/billing/workflow-free.

| Planned component | Responsibility |
|---|---|
| `access/` | Node.js/ARM64 Express OAuth/session/code/refresh endpoints with REST-v1 proxy adapter; bounded request-driven binding provisioning; own transaction/grant/binding state |
| `authorizer/` | Independently packaged managed Node.js 24.x/ARM64 Lambda ZIP; direct REST REQUEST handler using `methodArn`; signature/claim validation without datastore reads; exact-method policy and usageIdentifierKey; TTL 0 |
| `infra/access/auth.yaml`, `infra/access/storage.yaml`, `infra/access/runtime.yaml`, `infra/access/authorizer.yaml` | Create-mode Cognito, retained AccessState, separate Access and JWT-only authorizer functions, versions, roles and telemetry configuration; no REST gateway |
| `infra/access/gateway.yaml` | Base REST API, then all methods/integrations/permissions, deployment/named stage, discovery/GatewayResponses and native tier plans |
| Publication/verifiers | Protected OIDC publishing: authorizer ZIP to a versioned S3 artifact prefix, access image to ECR; read-only cutover manifest and separate local/live access evidence |

Use strict TypeScript/NodeNext and pinned Node.js LTS/ARM64 runtimes. Each component owns a lock/config; CI installs, typechecks, builds, tests emitted JS and packages production dependencies only. Keep access/authorizer/billing packages and roles isolated. Authorizer: managed Node.js 24.x ZIP, compiled modules plus production dependencies; JWT validation and public JWKS only, no Docker deployment.

Apply Hexagonal Architecture. `access/handler.ts` is the composition root; HTTP routes and native invocations are inbound adapters that validate transport, call use cases and map outcomes. Workflow services own transition and eligibility decisions and depend on ports in `access/ports.ts`; `AccessStore`, `CognitoIdentity`, and AWS clients implement outbound adapters. Keep Express/AWS SDK imports at boundaries and business transitions out of handlers.

Export the Express app separately from the REST-v1 Lambda adapter and local listener. Exercise stage/path, forms, cookies, multivalue headers and base64 bodies through the packaged adapter. Direct authorizer and billing SQS/scheduled handlers bypass Express. One [access table](contracts/access-storage.md) holds progress; required work never runs in detached promises or process-local timers. Billing owns payment reconciliation queues and replay; Access uses short status/resume requests and has no activation queue, stream or worker.

## Authoritative contracts

| Contract | Owns these details |
|---|---|
| [Client onboarding](contracts/client-onboarding.md) | Discovery, exact client/redirect/state/issuer/resource/S256 binding, browser session, code exchange and recovery |
| [Authorization](contracts/authorization.md) | Separate Cognito/service issuers, JWT claims/local signing/JWKS, refresh/revocation bounds and IAM |
| [Node.js onboarding](contracts/onboarding-workflow.md) | Conditional transitions, durable transaction/binding progress, leases, request retries, deadlines and compatibility |
| [Endpoints](contracts/endpoints.md) / [gateway](contracts/rest-gateway.md) | Routes/callers, discovery, subscriber metering, REST transport and cutover |
| [Infrastructure](contracts/managed-infrastructure.md) / [service boundary](contracts/service-integration.md) | Resource/output ownership, roles, bootstrap and cleanup |

Login/enrollment/management gates follow [FR-003/FR-004](spec.md#functional-requirements). Defaults: 30-minute absolute OAuth continuation; 60-second one-use code; one-hour access TTL bounded by subscription expiry; rotating refresh deadline at subscription expiry. Initial host clients are explicitly registered public clients. Do not advertise unimplemented CIMD/DCR/OIDC capabilities; verify actual callbacks and stage/path-issuer discovery before deployment.

Callbacks persist verified identity; access reads current entitlement and retries bounded provisioning through status/resume or fresh login. Billing alone owns delayed SQS and scheduled payment recovery. Conditional revisions, leases and current reads handle duplicates, crashes and stale workers. Browser status reads persisted progress; resume issues a code only after current readiness, and `/token` rechecks authority. Cancellation/retry never extends expiry or reverses paid state. See [delivery](contracts/background-delivery.md) for four-function boundaries and recovery.

Keys are per subscriber, associated with tier/stage outside authorization. Signed JWTs expose `usageIdentifierKey` to holders; authorizer returns that claim, never a header. Purchased Parameter Store catalog/mapping snapshots persist; current entitlement/binding gates issuance/refresh; revocation leaves existing access valid until expiry. Native quotas are best effort.

## Delivery and prerequisites

1. Bootstrap service/access publication and billing storage/read/outbox/stream interfaces independently.
2. Create base REST API without an empty deployment; derive explicit stage/resource/callback URLs.
3. Deploy identity/state/signing, service/billing/access aliases; then billing queue/replay wiring without circular imports.
4. Wire all gateway methods/permissions, deployment/stage and tier plans after aliases exist.
5. Validate before changing host endpoints; keep legacy HTTP secured or explicitly disable it through scoped cutover. Retain rollback, identities and billing/access state.

Spec 003 contracts define entitlement/history keys, catalog, eligibility and internal operations; implement/validate these before dependent access adapters. Spec 001 must prove packaged REST-v1 path/header/body behavior and supply its service-only alias/report-v2 interface. REST integration deadline is 29 seconds; service default stays 25 seconds. Legacy HTTP report v1/516 tests cannot establish REST readiness.

## Validation

Local suites cover OAuth/JWT/refresh, exact policies/token-only authorization, subscription/plan transitions, subscriber isolation, conditional state races, billing reconciliation and request-driven recovery, privacy, native handlers, IaC and read-only cutover/Cognito snapshot checks. The expanded crash/lease/replay, compatibility, packaged Access and full REST-to-MCP matrices remain open. See [tasks](tasks.md) and shared [readiness](../003-billing-subscriptions/checklists/implementation-readiness.md).

CI requires isolated installs, typecheck, compilation, emitted tests and packaged-handler checks; missing checks fail. Real ChatGPT/Claude/Cognito/Stripe/stream/schedule/native-metering/cutover acceptance remains not_run under local-only instruction. No provisioning, publication or charges have occurred.

Monitoring follows the [contract](contracts/observability.md) with [implemented helpers/templates](../../observability/README.md); runtime wiring and live acceptance remain pending.
