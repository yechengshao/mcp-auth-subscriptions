# Contract: Access-Owned Infrastructure

**Status**: Planned target; supersedes HTTP API adoption. [REST profile](rest-gateway.md) and [authorization](authorization.md) supply detailed requirements.

| Planned resource/artifact | Owner and interface |
|---|---|
| `infra/access/auth.yaml` | Cognito create/compatible reuse; retained transaction/work/grant/binding stores and due-work indexes; Parameter Store signing-key configuration/JWKS; access/authorizer aliases, roles and scoped logs |
| `infra/access/background.yaml` | Activation SQS/DLQ, stream Pipes, worker SQS mapping, existing-access replay schedule and scoped routing IAM |
| `infra/access/gateway.yaml` | Dedicated REST API, resources/methods/proxy integrations, REQUEST authorizer and all exact alias permissions, deployments/named stage/logs/GatewayResponses, tier usage plans |
| `access/`, `authorizer/` | Independent npm-locked TypeScript/Node.js components/images; Express coordinator and direct authorizer/workers, no MCP production dependency changes |
| `scripts/prepare_gateway_cutover.js` | Read-only before/target manifest, no import/update/delete/client reconfiguration |
| Access publication workflows | Protected main/environment OIDC; selected component repositories; test/build once/push same digest; no deployment or billing permission |
| `scripts/verify_access.ts` | Separate access evidence, local/live distinction, no secret/raw identity/key output |

## Nonsecret handoff

Gateway publishes REST API ID, explicit stage, REST type, exact MCP resource/health/discovery URLs, issuer and authorizer ID, deployment/method/resource identifiers and sanitized log correlation location. Access publishes access/authorizer alias/release identities, state schema/config version, queue/Pipe/SQS-mapping/DLQ and existing-function replay identities and public JWKS URL/key IDs; it never outputs private keys, bearer/refresh credentials or native key values. Spec 001 supplies exact function/live-alias/log/version/image outputs from planned service-only runtime-rest.yaml; spec 003 supplies exact billing alias, storage entitlement read interface and internal onboarding/reconciliation contract and sanitized durable activation-outbox/stream read interface. API/stage/resource/method identifiers replace HTTP route IDs/payload2.0/$default in new REST provenance.

Cognito reuse inputs form one compatible issuer/pool/client/domain set. Register coordinator's exact upstream callback, not each AI-host callback in Cognito. Host clients register downstream with the coordinator. Retain created Cognito and access state/signing resources; reused resources stay outside deletion ownership. Do not reset identities or duplicate shared account publishing providers.

## Permissions and lifecycle

MCP role: own logs only. Billing role: billing data/Stripe and independent configuration. Authorizer role: own logs and trusted JWKS retrieval only; no datastore grants. Coordinator role: own state, exact Parameter Store signing-key read/required decrypt under the authorization contract, read entitlement and exact billing IAM invocation; no kms:Sign grant. The same access role additionally has scoped access-state/work writes, billing outbox/entitlement reads, native-key/plan management and activation-queue consume/retry permissions; no Stripe secrets; signing-key read is shared with HTTP token routes. Pipe roles read selected streams and send transformed references to selected queues. EventBridge replay invokes only existing access/billing aliases under their owner's infrastructure. No Step Functions resources or `states:*` grants. The access function intentionally unifies HTTP/signing and reader/provisioner rights; minimize supported management action/resource scopes. Wiring in background.yaml follows storage and access aliases, with no billing-to-access resource dependency.

Gateway owns all REST integration and authorizer invocation permissions, pinned to exact aliases/API/stage/method paths plus SourceAccount. No MCP function URL or alternate public proxy. Billing Stripe webhook is a separate explicit route to billing with signature verification; it does not need a paid key. Public OAuth routes require their protocol/session checks, never an existing paid token.

Provision base REST API first, identity/state/functions then stream/schedule wiring next, then integrated methods/deployment/stage/plans. No deployment of an empty API. Cleanup respects inverse dependencies and retention; service removal requires access-owned methods/integration detachment first. Preserve the existing legacy HTTP API unless an explicitly scoped migration action changes it. No cloud operation occurs during planning.

The [onboarding contract](onboarding-workflow.md) governs durable transitions/work, leases, recovery, privacy and schema/release compatibility. Background infrastructure must define bounded batches/retries, partial-batch failure handling, retained failure records, due-work pagination and alarms. A stopped/failed worker is recovered from durable records, not process memory. Preserve outstanding work during releases/rollback and keep handlers compatible with existing unexpired schemas. Cleanup cancels only owned transactions and retains paid records.

Function counts, SQS delays, retry/DLQ handling and replay guarantees are authoritative in [background delivery](background-delivery.md); no dedicated recovery or routing Lambda is provisioned.
