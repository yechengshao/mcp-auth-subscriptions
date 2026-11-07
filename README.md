# MCP Auth and Subscriptions

Authentication and subscription service for the sibling [TradingView MCP service](../tradingview-mcp/README.md).

## Implementation stack

Use **TypeScript, Node.js, Express, and AWS Lambda** for authentication and subscription billing. Express handles HTTP routes through a REST API Gateway Lambda proxy adapter; the authorizer uses a direct handler and billing dispatches native SQS/replay events. The [authentication plan](specs/002-authentication-api-access/plan.md) defines packaging and handler boundaries. Implementation is pending.

## Ownership

- [Spec 002 — Authentication and API Access](specs/002-authentication-api-access/spec.md): Cognito social login, authorization code + PKCE, client tokens and refresh, DynamoDB-backed Node.js onboarding, REST gateway, independent token-validating authorizer, and native per-subscriber usage plans.
- [Spec 003 — Billing and Subscriptions](specs/003-billing-subscriptions/spec.md): plan selection, orders, Stripe Checkout/portal, verified webhooks, reconciliation, retained billing state, and entitlement publication.
- The MCP service and provider logic stay in `../tradingview-mcp`. Integration uses its [service-only contract](../tradingview-mcp/specs/001-add-lambda-deployment/contracts/rest-migration.md); do not import identity/payment logic or secrets into that runtime.

## Current status

Created on 2026-11-04 by moving the existing complete `specs/002-authentication-api-access/` and `specs/003-billing-subscriptions/` directories from `tradingview-mcp`. Requirements are preserved with the current runtime and onboarding decisions reflected in the linked plans. Authentication has 25 unchecked tasks; billing now has a draft technical plan, physical interface and 14 unchecked tasks. No authentication/billing implementation, cloud deployment, payment action, or live acceptance is claimed by this project creation.

Start with the [specification index](specs/README.md), [authentication plan](specs/002-authentication-api-access/plan.md), [authentication tasks](specs/002-authentication-api-access/tasks.md), and [billing specification](specs/003-billing-subscriptions/spec.md). The active feature selector points to spec 003; this minimal project does not copy the service repository's workflow/skill scaffold.

## Project layout

```text
mcp-auth-subscriptions/
  .specify/feature.json
  README.md
  specs/
    README.md
    002-authentication-api-access/
    003-billing-subscriptions/
```

Keep this project and `tradingview-mcp` as sibling folders so local integration links resolve. The service repository owns spec 001. The `origin` remote is [yechengshao/mcp-auth-subscriptions](https://github.com/yechengshao/mcp-auth-subscriptions), using SSH; the default branch is `main`.

Planned runtime: four Lambdas total including MCP—access (HTTP/on-demand provisioning), authorizer, billing, and MCP—with billing SQS/Pipe and replay schedule on existing consumers; see the [background delivery contract](specs/002-authentication-api-access/contracts/background-delivery.md).
