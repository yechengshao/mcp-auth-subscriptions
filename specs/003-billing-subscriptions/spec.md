# Spec 003: Billing and Subscriptions

**Created/updated**: 2026-11-05 · **Branch**: `main` · **Status**: Planned; technical plan/tasks drafted, implementation pending.

**Length exception**: Retain the existing payment-integrity, ownership and recovery requirements together to preserve their IDs and testable failure behavior.

## Scope and confirmed decisions

Use **Node.js and Express on a separate AWS Lambda, with DynamoDB**, for plan selection, orders, Stripe Checkout/portal, subscription records and entitlement publication. [Spec 002](../002-authentication-api-access/spec.md) owns Cognito/Node.js onboarding, client tokens and subscription enforcement at login/token issuance/refresh and token validation in the authorizer. [Spec 001](../../../tradingview-mcp/specs/001-add-lambda-deployment/spec.md) provides MCP only.

After identity verification, unpaid users may only select/purchase/renew and inspect their purchase through a bounded enrollment continuation; application login and billing management follow [access FR-003/FR-004](../002-authentication-api-access/spec.md#functional-requirements). Billing commits trusted plan/expiry plus a durable activation notification. Access completes OAuth only after entitlement and native usage binding are ready. Eligible reconnect and late-payment recovery reuse the subscription without another purchase.

## User scenarios and acceptance

### Story 1 — Subscribe and manage billing (P1)

Verified users without a subscription can create/reuse an own-account purchase and open Checkout. Only currently eligible paid users may manage billing or enter a management portal. Expiry/revocation blocks the next management request despite prior login or saved links. Reject arbitrary prices and cross-user references; browser returns cannot grant access.

### Story 2 — Process provider events reliably (P1)

Verify the exact signed body before writes. Duplicate, reordered, concurrent and partially failed processing converges to authoritative provider state without duplicate effects, stale regression or premature acknowledgement.

### Story 3 — Publish enforceable entitlements (P1)

Commit identity-bound eligibility/plan/paid-validity/revision. The access issuer uses current reads; denied/expired/missing/unavailable state blocks new tokens under the [access revocation bounds](../002-authentication-api-access/contracts/authorization.md#denial-and-revocation). Billing outages do not affect internal MCP readiness.

### Story 4 — Release and recover independently (P2)

Billing release/rollback and service cleanup preserve identities and billing records. Durable notifications/reconciliation recover delayed callbacks, including payment after OAuth expiry, without another charge or an expired grant.

**Edge cases**: wrong identity/environment; unknown customer; arbitrary plan/price; cancellation/trial/past-due states; TTL cleanup delay; duplicate/out-of-order events; processing crashes; Stripe/storage/stream outage; expired/cross-user continuation; abandoned checkout. Explicit policy determines eligibility.

## Functional requirements

- **FR-001**: Deploy billing independently in its own Lambda/configuration/version/role with DynamoDB state.
- **FR-002**: Use explicit approved Stripe products/prices/currencies/plans and test/live environment inputs; invent no pricing defaults.
- **FR-003**: Derive ownership from verified Cognito issuer/subject supplied by access; email/client/customer IDs cannot establish ownership.
- **FR-004**: Verify Stripe signatures over exact received bytes before mutation; webhook targets billing, never MCP, without requiring human login.
- **FR-005**: Durably handle duplicate/retried/reordered/concurrent events and partial failure; reconcile provider authority, prevent stale regression and acknowledge only committed outcomes.
- **FR-006**: Own customer/subscription/event/reconciliation/entitlement writes; grant access only required projection/outbox reads, and MCP no data access.
- **FR-007**: Publish identity-keyed eligibility, approved paid plan, future paid-through bound and committed revision. Validity requires active paid eligibility without revocation; scheduled cancellation remains valid through the paid bound, while unpaid trials, pending, past-due and expired states do not qualify. Access enforces the projection; MCP does not.
- **FR-008**: Deny login/token issuance/refresh for missing/denied/expired/unavailable entitlement; apply [access FR-008/FR-014](../002-authentication-api-access/spec.md#functional-requirements) to outstanding tokens, checking expiry independently of TTL deletion.
- **FR-009**: Enforce the login, purchase-only enrollment and paid billing-management boundaries in [access FR-003/FR-004](../002-authentication-api-access/spec.md#functional-requirements) on every billing operation; browser claims never establish eligibility. Collect/store no raw card data.
- **FR-010**: Keep Stripe API/signing secrets billing-only; exclude secrets, access tokens, full provider payloads and unnecessary customer/payment data from logs/evidence.
- **FR-011**: Provide recoverable reconciliation/retry diagnostics and durable deduplication beyond short-lived request-idempotency tokens; preserve records during recovery.
- **FR-012**: Retain billing state across releases/default cleanup; destructive cleanup must select owned resources and exclude unrelated/imported records.
- **FR-013**: Test billing/token-issuer/authorizer boundaries locally; separate fixtures from live Stripe/cloud acceptance and mark unavailable live checks not_run.
- **FR-014**: Bootstrap storage/read interfaces independently of processor/identity wiring to avoid a Cognito↔billing provisioning cycle.
- **FR-015**: Provide purchase/renewal plan selection, own-order creation/Checkout and purchase status through a verified bounded enrollment continuation without a paid MCP token/key; grant no general billing-management capability and reject altered/cross-user/arbitrary-price requests.
- **FR-016**: Durably bind approved plan/order/Checkout/subscription to the same identity/environment; retries cannot duplicate purchases. Reuse eligible subscriptions unless deliberately changing plan.
- **FR-017**: Report activation only after verified provider state commits plan/expiry; distinguish paid/pending/failed/cancelled outcomes. Access alone issues tokens/provisions native keys/completes OAuth.
- **FR-018**: Preserve payment through delayed/expired OAuth and reuse it after fresh login. Use approved opaque return redirects; send no OAuth state/verifiers/bearer/refresh credentials to Stripe.
- **FR-019**: Commit a durable activation notification with the billing decision before signaling access; recover failed/duplicate/reordered delivery without lost payment or repurchase. Keep access-owned transaction/work state outside billing/Stripe/client interfaces.
- **FR-020**: Provide short idempotent own-order reconciliation for onboarding recovery. Billing queries Stripe; access persists pending state and schedules bounded recovery/retries.

## Key entities

Identity/customer mapping; approved catalog; order/Checkout continuation; subscription; durable provider-event outcome; entitlement projection; activation notification; reconciliation result. Physical storage and operation schemas belong to technical planning.

## Success criteria

- **SC-001**: Own-account purchase uses the correct identity/catalog; cross-user/arbitrary-price cases cause zero provider effects, and invalid-subscription management cases disclose zero billing records and cause zero management effects.
- **SC-002**: Invalid signatures/body tampering cause zero writes; at least ten duplicate deliveries, including concurrency, produce one committed business effect.
- **SC-003**: Reordered/concurrent events converge to authoritative state without stale/incomplete access grants.
- **SC-004**: Expiry and committed transitions affect the next login, billing-management, issuance or refresh decision; outstanding access follows access FR-008/FR-014, invalid/expired tokens invoke MCP zero times and internal readiness remains independent.
- **SC-005**: Release/recovery/service cleanup preserves customer/subscription/event data without MCP business-logic or identity changes.
- **SC-006**: Reports distinguish fixtures, live provider results and unperformed checks; browser return/deployment/mocks alone cannot prove payment readiness.
- **SC-007**: Purchase/reconnect/retry/delayed-payment/expired-OAuth scenarios preserve identity/plan with zero duplicate purchases or unverified activation.
- **SC-008**: Successful activation supplies current plan/expiry; combined OAuth issues no tokens until trusted entitlement and ready usage binding exist.
- **SC-009**: Early/duplicate/reordered/failed callback delivery recovers through durable notification/reconciliation; expired OAuth produces zero grants and requires no repurchase.

## Assumptions and planning inputs

- Paid eligibility is defined in FR-007; catalog/prices and retention remain operator/planning inputs.
- Billing owns browser plan/order/status content; Stripe hosts payment entry; any management portal must enforce FR-009 even for previously issued sessions/links, or the design must use guarded management operations instead. Pricing design, strict usage-credit billing, tax and refund/dispute automation are outside this initial scope.
- Provider changes become locally authoritative after verified delivery/reconciliation; immediate awareness before that is not promised.
- Technical planning must finalize catalog/status policy, tables/indexes, secrets, Stripe versions, retention/reconciliation, and outbox/stream/read/reconciliation interfaces for access.
- Testing is local-only; no real charges, Stripe configuration, webhook registration or AWS provisioning is authorized by this draft.

[Plan](plan.md) · [Tasks](tasks.md) · [Physical interface](contracts/storage-operations.md) · [Entitlements](contracts/entitlements.md) · [Checkout/onboarding](contracts/checkout-onboarding.md) · [Feature boundaries](../../../tradingview-mcp/specs/README.md)
