# MCP Auth and Subscriptions

Authentication and subscription service for the sibling [TradingView MCP service](../tradingview-mcp/README.md).

## Implementation stack

Use **TypeScript, Node.js, Express, and AWS Lambda** for authentication and subscription billing. Express handles HTTP routes through a REST API Gateway Lambda proxy adapter; the authorizer uses a direct handler and billing dispatches native SQS/replay events. The [authentication plan](specs/002-authentication-api-access/plan.md) defines packaging and handler boundaries. Local contracts and monitoring helpers/templates are implemented; business HTTP handlers and deployed infrastructure remain pending.

## Ownership

- [Spec 002 — Authentication and API Access](specs/002-authentication-api-access/spec.md): Cognito social login, authorization code + PKCE, client tokens and refresh, DynamoDB-backed Node.js onboarding, REST gateway, independent token-validating authorizer, and native per-subscriber usage plans.
- [Spec 003 — Billing and Subscriptions](specs/003-billing-subscriptions/spec.md): plan selection, orders, one-time Stripe Checkout, verified webhooks, reconciliation, retained billing state, and entitlement publication; financial support requests use email and the hosted portal is disabled.
- The MCP service and provider logic stay in `../tradingview-mcp`. Integration uses its [service-only contract](../tradingview-mcp/specs/001-add-lambda-deployment/contracts/rest-migration.md); do not import identity/payment logic or secrets into that runtime.

## Current status

As of 2026-11-10 (the [access](specs/002-authentication-api-access/tasks.md) and [billing](specs/003-billing-subscriptions/tasks.md) task files are authoritative): access has 3 of 25 tasks checked (T002–T004, the authorizer); billing has 9 of 14 checked (B001–B009), with B010–B014 (packaging, publication, shared integration, CI, live validation) open. Several access tasks (T014–T020) have substantial local code but stay unchecked until their acceptance criteria close. Local implementation covers catalog/record validation, purchase snapshots, UTC terms, session boundaries and [monitoring wrappers/templates](observability/README.md). See [implementation scope and checks](billing/contracts/README.md). Deployed authentication/payment flows and all live acceptance remain unrun.

Start with the [specification index](specs/README.md), [authentication plan](specs/002-authentication-api-access/plan.md), [authentication tasks](specs/002-authentication-api-access/tasks.md), and [billing specification](specs/003-billing-subscriptions/spec.md). The active feature selector points to spec 003; this minimal project does not copy the service repository's workflow/skill scaffold.

## Project layout

```text
mcp-auth-subscriptions/
  .specify/feature.json
  README.md
  package.json
  billing/contracts/
  access/contracts/
  observability/
  infra/observability/
  tests/{access,billing,fixtures,observability}/
  specs/
    README.md
    002-authentication-api-access/
    003-billing-subscriptions/
```

Keep this project and `tradingview-mcp` as sibling folders so local integration links resolve. The service repository owns spec 001. The `origin` remote is [yechengshao/mcp-auth-subscriptions](https://github.com/yechengshao/mcp-auth-subscriptions), using SSH; the default branch is `main`.

Planned runtime: four Lambdas total including MCP—access (HTTP/on-demand provisioning), authorizer, billing, and MCP—with billing SQS/Pipe and replay schedule on existing consumers; see the [background delivery contract](specs/002-authentication-api-access/contracts/background-delivery.md).

Planned DynamoDB inventory: `AccessState` (access), `BillingState` (billing details/history), and `BillingEntitlements` (billing-owned projection for access). Billing commits detailed state and entitlement atomically; access has no detailed billing-table grants.

For local development with Node 24 or newer, run `npm ci` and `npm run check`. Tests compile TypeScript before execution and use synthetic fixtures without AWS/Stripe access. The root package hosts contract/monitoring code and tests; separately packaged Lambda runtimes remain future tasks.
