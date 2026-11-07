# Plan 002: Authentication and API Access

**Updated**: 2026-11-06 · **Status**: Planned; 25 unchecked tasks. [Spec](spec.md) · [Tasks](tasks.md)

## Architecture

Cognito human PKCE → billing plan/order/Stripe → committed entitlement → native usage binding → OAuth code exchange → short-lived service bearer. Existing eligible subscribers skip purchase. Node.js application logic coordinates persisted DynamoDB transitions; short access requests and billing payment recovery advance the flow without Step Functions. The REQUEST authorizer checks every paid request synchronously. MCP remains authentication/billing/workflow-free.

| Planned component | Responsibility |
|---|---|
| `access/` | Node.js/ARM64 Express OAuth/session/code/refresh endpoints with REST-v1 proxy adapter; bounded request-driven binding provisioning; own transaction/grant/binding state |
| `authorizer/` | Independently packaged Node.js/ARM64 direct REST REQUEST handler using `methodArn`; signature/claim validation without datastore reads; exact-method policy and usageIdentifierKey; TTL 0 |
| `infra/access/auth.yaml` | Retained Cognito create/compatible reuse, access stores/Parameter Store signing-key configuration/JWKS, access/authorizer functions/versions/roles/logs |
| `infra/access/gateway.yaml` | Base REST API, then all methods/integrations/permissions, deployment/named stage, discovery/GatewayResponses and native tier plans |
| Publication/verifiers | Independent protected OIDC/ECR component workflows; read-only cutover manifest and separate local/live access evidence |

Use strict TypeScript with NodeNext ES modules, maintained OAuth/JWT libraries and AWS SDK for JavaScript v3. Each component owns `package.json`/`package-lock.json` and `tsconfig.json`; use `npm ci`, `npm run typecheck` (`tsc --noEmit`) and `npm run build` (`tsc`). Compile `.ts` sources/tests/scripts to JavaScript; run emitted tests with Node's test runner and package compiled handlers/runtime dependencies only. Pin TypeScript, Node/Express/Lambda types, adapter and supported Node.js LTS ARM64 Lambda image/digest; match local/CI runtimes. Lambda entrypoints target emitted `.js`. Access/authorizer/billing roles remain separate; authorizer cannot sign, provision keys or write billing. Access holds no Stripe secrets or billing-write grant.

Export the Express app separately from its Lambda adapter and local listener. Use form parsing for OAuth token requests; test REST-v1 stage/path handling, cookies, multivalue headers and base64 bodies through the packaged adapter. Direct authorizer and billing SQS/scheduled handlers bypass Express. Test the app over HTTP and exported handlers with Lambda events. Billing uses the same stack in its own package/function; its physical interfaces remain spec 003 planning work. DynamoDB holds progress between requests; no required work runs in detached promises or process-local timers.

## Authoritative contracts

| Contract | Owns these details |
|---|---|
| [Client onboarding](contracts/client-onboarding.md) | Discovery, exact client/redirect/state/issuer/resource/S256 binding, browser session, code exchange and recovery |
| [Authorization](contracts/authorization.md) | Separate Cognito/service issuers, JWT claims/local signing/JWKS, refresh/revocation bounds and IAM |
| [Node.js onboarding](contracts/onboarding-workflow.md) | Conditional transitions, durable work/outbox, leases, request retries, deadlines and compatibility |
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

Spec 003 planning must finalize physical entitlement/outbox keys/read policies, catalog/eligibility, short internal onboarding/reconciliation operations and processor alias. Spec 001 must prove packaged REST-v1 path/header/body behavior and supply its service-only alias/report-v2 interface. REST integration deadline is 29 seconds; service default stays 25 seconds. Legacy HTTP report v1/516 tests cannot establish REST readiness.

## Validation

Local suites cover OAuth/JWT/refresh, exact policies/token-only authorization, subscription/plan transitions, subscriber isolation, conditional state races, crashes/leases/replay, billing reconciliation and request-driven recovery, privacy, compatible releases/rollback, native handlers, IaC and read-only cutover. See [tasks](tasks.md) for the dependency graph and case assignments.

CI requires isolated installs, typecheck, compilation, emitted tests and packaged-handler checks; missing checks fail. Real ChatGPT/Claude/Cognito/Stripe/stream/schedule/native-metering/cutover acceptance remains not_run under local-only instruction. No provisioning, publication or charges have occurred.

CloudWatch logs/metrics/alarms and X-Ray tracing follow the [observability contract](contracts/observability.md).
