# Contract: Access-Owned Infrastructure

**Status**: Planned target; supersedes HTTP API adoption. [REST profile](rest-gateway.md) and [authorization](authorization.md) supply detailed requirements.

| Planned resource/artifact | Owner and interface |
|---|---|
| `infra/access/auth.yaml` | Cognito create/compatible reuse; retained transaction/work/grant/binding stores and due-work indexes; Parameter Store signing-key configuration/JWKS; access/authorizer aliases, roles and scoped logs |
| `infra/access/gateway.yaml` | Dedicated REST API, resources/methods/proxy integrations, REQUEST authorizer and all exact alias permissions, deployments/named stage/logs/GatewayResponses, tier usage plans |
| `access/`, `authorizer/` | Independent npm-locked TypeScript/Node.js components/images; Express access with request-driven provisioning and direct authorizer, no MCP production dependency changes |
| `scripts/prepare_gateway_cutover.ts` | Read-only before/target manifest, no import/update/delete/client reconfiguration |
| Access publication workflows | Protected main/environment OIDC; selected component repositories; test/build once/push same digest; no deployment or billing permission |
| `scripts/verify_access.ts` | Separate access evidence, local/live distinction, no secret/raw identity/key output |

## Nonsecret handoff

Gateway publishes REST API ID, explicit stage, REST type, exact MCP resource/health/discovery URLs, issuer and authorizer ID, deployment/method/resource identifiers and sanitized log correlation location. Access publishes access/authorizer alias/release identities, state schema/config version, binding schema and public JWKS URL/key IDs; it never outputs private keys, bearer/refresh credentials or native key values. Spec 001 supplies exact function/live-alias/log/version/image outputs from planned service-only runtime-rest.yaml; spec 003 supplies exact billing alias, consistent entitlement read interface and internal onboarding/reconciliation operations; billing history/stream reads are not granted to access. API/stage/resource/method identifiers replace HTTP route IDs/payload2.0/$default in new REST provenance.

Cognito reuse inputs form one compatible issuer/pool/client/domain set. Register coordinator's exact upstream callback, not each AI-host callback in Cognito. Host clients register downstream with the coordinator. Retain created Cognito and access state/signing resources; reused resources stay outside deletion ownership. Do not reset identities or duplicate shared account publishing providers.

## Permissions and lifecycle

MCP role: own logs only. Billing role: billing data/Stripe and independent configuration. Authorizer role: own logs, scoped X-Ray telemetry export and trusted JWKS retrieval; no datastore grants. Coordinator role: own state, exact Parameter Store signing-key read/required decrypt under the authorization contract, read entitlement and exact billing IAM invocation; no kms:Sign grant. The same access role additionally has scoped access-state/binding writes, entitlement reads and native-key/plan management; no Stripe secrets; signing-key read is shared with HTTP token routes. Access has no SQS/stream/scheduled-replay permissions or infrastructure. Billing-owned Pipe/queue/DLQ/mapping and existing-billing replay are defined by spec 003. No Step Functions resources or states grants. Access intentionally combines HTTP signing and provisioning permissions; minimize native management scopes.

Gateway owns all REST integration and authorizer invocation permissions, pinned to exact aliases/API/stage/method paths plus SourceAccount. No MCP function URL or alternate public proxy. Billing Stripe webhook is a separate explicit route to billing with signature verification; it does not need a paid key. Public OAuth routes require their protocol/session checks, never an existing paid token.

Provision base REST API first, identity/state/functions then billing queue/replay wiring next, then integrated methods/deployment/stage/plans. No deployment of an empty API. Cleanup respects inverse dependencies and retention; service removal requires access-owned methods/integration detachment first. Preserve the existing legacy HTTP API unless an explicitly scoped migration action changes it. No cloud operation occurs during planning.

The [onboarding contract](onboarding-workflow.md) governs durable request-driven transitions, provisioning leases, pending/retry state and release compatibility. Resume/new login recovers unfinished activation; with no browser requests it remains pending. Preserve payment/binding records and support existing schemas across rollback. Paid records survive expired continuations.

Function counts, SQS delays, retry/DLQ handling and replay guarantees are authoritative in [background delivery](background-delivery.md); no dedicated recovery or routing Lambda is provisioned.

Component IaC and handlers must implement the shared [CloudWatch/X-Ray contract](observability.md), including finite log retention, credential redaction, telemetry IAM, dashboards/alarms and separately validated live delivery.

Access and billing receive exact-parameter read permission for the nonsecret shared catalog under the [catalog contract](../../003-billing-subscriptions/contracts/plan-catalog.md); no runtime catalog-write grant. Active-ready login/refresh uses current DynamoDB snapshots without requiring the latest catalog.
