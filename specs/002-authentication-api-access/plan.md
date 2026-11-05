# Plan 002: Authentication and API Access

**Updated**: 2026-11-04 · **Status**: Planned; 25 unchecked tasks. [Spec](spec.md) · [Tasks](tasks.md)

## Architecture

Cognito human PKCE → billing plan/order/Stripe → committed entitlement → native usage binding → OAuth code exchange → short-lived service bearer. Existing eligible subscribers skip purchase. Node.js application logic coordinates persisted DynamoDB transitions; short Lambda endpoints, event handlers and scheduled recovery advance the flow without Step Functions. The REQUEST authorizer checks every paid request synchronously. MCP remains authentication/billing/workflow-free.

| Planned component | Responsibility |
|---|---|
| `access/` | Node.js/ARM64 Express OAuth/session/code/refresh endpoints with REST-v1 proxy adapter; direct callback/provisioning/reconciliation workers; own transaction/grant/binding state |
| `authorizer/` | Independently packaged Node.js/ARM64 direct REST REQUEST handler using `methodArn`; current consistent grant/entitlement/binding reads; exact-method policy and usageIdentifierKey; TTL 0 |
| `infra/access/auth.yaml` | Retained Cognito create/compatible reuse, access stores/KMS signing/JWKS, worker/authorizer functions/versions/roles/logs |
| `infra/access/background.yaml` | Scoped DynamoDB Streams mappings, EventBridge recovery schedule, bounded retries/failure retention and worker invoke permissions |
| `infra/access/gateway.yaml` | Base REST API, then all methods/integrations/permissions, deployment/named stage, discovery/GatewayResponses and native tier plans |
| Publication/verifiers | Independent protected OIDC/ECR component workflows; read-only cutover manifest and separate local/live access evidence |

Use JavaScript ES modules, maintained OAuth/JWT libraries and AWS SDK for JavaScript v3. Each component owns `package.json`/`package-lock.json`; install with `npm ci`. Pin a supported Node.js LTS Lambda base image/digest and adapter version at implementation, with matching local/CI runtimes. Keep dependencies outside the MCP project. Coordinator/event-worker/provisioner/authorizer permissions remain separate; authorizer cannot sign, provision keys or write billing. Access holds no Stripe secrets or billing-write grant.

Export the Express app separately from its Lambda adapter and local listener. Use form parsing for OAuth token requests; test REST-v1 stage/path handling, cookies, multivalue headers and base64 bodies through the packaged adapter. Direct authorizer and stream/scheduled handlers bypass Express. Use Node's test runner for local suites, with HTTP tests against the app and Lambda-event tests against exported handlers. Billing uses the same stack in its own package/function; its physical interfaces remain spec 003 planning work. DynamoDB holds progress between requests; no required work runs in detached promises or process-local timers.

## Authoritative contracts

| Contract | Owns these details |
|---|---|
| [Client onboarding](contracts/client-onboarding.md) | Discovery, exact client/redirect/state/issuer/resource/S256 binding, browser session, code exchange and recovery |
| [Authorization](contracts/authorization.md) | Separate Cognito/service issuers, JWT claims/KMS/JWKS, refresh/revocation, current reads and IAM |
| [Node.js onboarding](contracts/onboarding-workflow.md) | Conditional transitions, durable work/outbox, leases, deadlines, scheduled recovery and release compatibility |
| [REST gateway](contracts/rest-gateway.md) | Stage-prefixed endpoint, native subscriber keys/plans, REST-v1 transport and legacy cutover |
| [Infrastructure](contracts/managed-infrastructure.md) / [service boundary](contracts/service-integration.md) | Resource/output ownership, roles, bootstrap and cleanup |

Login/enrollment/management gates follow [FR-003/FR-004](spec.md#functional-requirements). Defaults: 30-minute absolute OAuth continuation; 60-second one-use code; five-minute access TTL bounded by paid expiry; 24-hour rotating refresh grant. Initial host clients are explicitly registered public clients. Do not advertise unimplemented CIMD/DCR/OIDC capabilities; verify actual callbacks and stage/path-issuer discovery before deployment.

Callbacks atomically persist trusted state and required work; streams trigger idempotent workers and EventBridge invokes bounded due-work/expiry recovery. Conditional revisions, leases and current reads handle duplicates, crashes and stale workers. Browser status reads persisted progress; resume issues a code only after current readiness, and `/token` rechecks authority. Cancellation/retry never extends expiry or reverses paid state. See the onboarding contract for outbox-gap and uncertain-provider recovery.

Native keys are private and per subscriber, associated with the current tier/stage outside the authorizer. Paid methods require AUTHORIZER-supplied keys; raw values never enter JWT/browser/evidence. Current entitlement and ready binding control access. Native quotas are best effort request metering.

## Delivery and prerequisites

1. Bootstrap service/access publication and billing storage/read/outbox/stream interfaces independently.
2. Create base REST API without an empty deployment; derive explicit stage/resource/callback URLs.
3. Deploy identity/state/signing, service/billing and access worker aliases; then stream/schedule wiring without circular imports.
4. Wire all gateway methods/permissions, deployment/stage and tier plans after aliases exist.
5. Validate before changing host endpoints; keep legacy HTTP secured or explicitly disable it through scoped cutover. Retain rollback, identities and billing/access state.

Spec 003 planning must finalize physical entitlement/outbox keys/read policies, catalog/eligibility, short internal onboarding/reconciliation operations and processor alias. Spec 001 must prove packaged REST-v1 path/header/body behavior and supply its service-only alias/report-v2 interface. REST integration deadline is 29 seconds; service default stays 25 seconds. Legacy HTTP report v1/516 tests cannot establish REST readiness.

## Validation

Local suites cover OAuth/JWT/refresh, exact policies/current reads, subscription/plan transitions, subscriber isolation, conditional state races, crashes/leases/replay, stream-gap recovery, privacy, compatible releases/rollback, native handlers, IaC and read-only cutover. See [tasks](tasks.md) for the dependency graph and case assignments.

Separate CI installs isolated required dependencies and fails missing selected checks. Real ChatGPT/Claude/Cognito/Stripe/stream/schedule/native-metering/cutover acceptance remains not_run under local-only instruction. No provisioning, publication or charges have occurred. The adopted constitution governs documentation revisions.
