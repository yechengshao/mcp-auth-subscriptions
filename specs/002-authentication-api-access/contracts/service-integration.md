# Contract: Service, Access and Billing Ownership

| Concern | 001 — service | 002 — access | 003 — billing |
|---|---|---|---|
| Runtime | Existing 39 tools, stateless buffered MCP, readiness, provider env | Node.js/Express onboarding, short OAuth/callback handlers, authorizer, key-provisioning worker | Separate Stripe/onboarding Lambda |
| State | In-process tool caches only | Conditional onboarding state/durable work; OAuth transactions/grants/revocation, private subscriber-key bindings, signing | Orders/customer/subscription/event/entitlement records |
| Authentication | None in MCP process | Cognito upstream human PKCE, client-facing OAuth/code/token/JWKS, REST custom authorization | Accept verified internal identity; verify raw Stripe webhook |
| Gateway target | Supplies exact MCP alias/version/log/host requirements | Owns all REST API resources/methods/integrations/permissions/stage/plans/public discovery/challenges | Supplies exact billing alias and operation contracts |
| Images/publication | Service ECR/workflow/scoped publishing IAM | Separate component ECR/workflows/scoped identities | Own future artifact/publication |
| Eligibility | No data/dependency/IAM | Current grant/entitlement/binding checks at issuance/refresh; token-only authorizer | Verified payment and committed plan/expiry eligibility |

The delivered `infra/lambda/runtime.yaml` is **legacy HTTP API v2** and owns three HTTP attachments. Its existing commands/schema/tests retain that meaning. The planned `infra/lambda/runtime-rest.yaml` is service-only and cannot own REST methods/invoke permissions also created by access. Gateway detachment is an access action before service cleanup; MCP's provider environment stays the nine `.env.example` keys in native Lambda environment variables with no fetch hook.

Canonical target MCP URL includes the REST named stage. Event v1 path/header/body handling and adapter integration need spec-001 proof. Keep stateless finite JSON, exact host checks, internal health and compatible local/Docker/GHCR behavior. REST slash handling is verified at the edge; do not fabricate a second empty-path resource. Compare full function/alias identities for bypass detection, never name substrings.

Billing commits entitlement and a durable activation notification for a verified upstream identity. Access HTTP onboarding handlers consistently read current entitlement and prepare the subscriber binding with bounded request-driven retries. Short coordinator endpoints retain the client OAuth transaction and complete code/token exchange after ready state. No HTTP/Lambda invocation stays open through payment waiting; access work records remain internal. Authorizer validates only the service JWT and its signed claims without datastore reads, returning its signed usageIdentifierKey for paid REST methods; it does not change headers or query Stripe. No access/billing claims, keys, datastore grants or JWT SDK enter the service.

Spec 001's existing [report schema](../../../../tradingview-mcp/specs/001-add-lambda-deployment/contracts/verification-report.schema.json) is v1/HTTP-only and stays byte-identical. A planned independent REST report v2 must encode REST/stage/resource/method provenance and retain current stage/semantic rigor. Access verification separately proves grants/payment activation/metering; service verification proves transport/denial-before-service/release identity. Prior 516 service tests and local fixtures prove neither live host login nor payment.
