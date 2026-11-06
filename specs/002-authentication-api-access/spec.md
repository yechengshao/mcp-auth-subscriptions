# Spec 002: Authentication and API Access

**Created/updated**: 2026-11-05 · **Branch**: `main` · **Status**: Planned; implementation pending.

**Length exception**: Retain the existing security, migration and workflow acceptance requirements together to preserve their IDs and testable failure behavior.

## Scope and confirmed decisions

Connect ChatGPT/Claude through this journey:

**Verify identity → purchase/renew if needed → verified paid entitlement → usage-plan activation → successful application login/OAuth completion → MCP access.**

Use human authorization code + S256 PKCE, persisted Node.js transitions for waiting/recovery, a **REST API with native usage plans**, and an independent custom authorizer validating signed service tokens. Implement access in **Node.js on AWS Lambda**, using **Express** for HTTP/callbacks/token exchange. [Spec 001](../../../tradingview-mcp/specs/001-add-lambda-deployment/spec.md) provides MCP only; [spec 003](../003-billing-subscriptions/spec.md) provides separate billing Lambda/DynamoDB/Stripe.

REST replaces the earlier HTTP-adoption plan through an explicit new-endpoint cutover. Host connect/sign-in/first use controls browser login; installation alone is not a universal trigger. Eligible subscribers skip purchase.

## User scenarios and acceptance

### Story 1 — Connect and subscribe (P1)

Discovery starts a bound client/redirect/state/resource/scope/PKCE transaction. Unpaid verified users receive only a bounded purchase/renewal continuation, not successful application login. Committed entitlement plus ready usage binding permits one-use code exchange; pending/cancelled/unverified/expired checkout produces no grant. Eligible reconnect creates no new order.

### Story 2 — Enforce and meter access (P1)

Valid signed service tokens reach only the intended method using their signed subscriber usage key. Invalid, missing or expired credentials invoke MCP zero times. Same-tier subscribers have separate metering keys; subscription changes block new credentials but existing access lasts until token expiry.

### Story 3 — Restrict login and billing management (P1)

Given a valid paid subscription, verified users can complete login and manage only their own billing. Given an unpaid/expired/revoked account, login and billing management fail, including through old links or sessions. Renewal is purchase-only. Refresh rechecks authority; unavailable eligibility denies with a retryable outcome.

### Story 4 — Migrate and release safely (P2)

Keep old HTTP and new REST endpoints distinct; verify transport, discovery, OAuth/payment, metering and rollback before cutover. Preserve users/data and reject conflicting resource ownership. Reports distinguish local checks from unperformed cloud/host acceptance.

### Story 5 — Resume asynchronous onboarding (P1)

DynamoDB stores progress between short HTTP/worker requests. Early/duplicate/reordered callbacks advance the correct transaction without duplicate effects. Crash/cancellation/retry preserves the original deadline; scheduled recovery works with the browser closed, and late payment requires no repurchase.

**Edge cases**: altered state/PKCE/redirect/resource; code/refresh replay; CSRF/concurrent tabs; cross-user continuation; abandoned/delayed payment; key rotation/propagation; stale plan/revision; unavailable stores; alternate-stage/proxy/legacy bypasses; expiry during login or an existing billing session; saved portal links.

## Functional requirements

- **FR-001**: Support approved ChatGPT/Claude public clients with Cognito human S256 PKCE, exact redirects and immutable verified identity.
- **FR-002**: Independently deploy the authorizer; validate signature/issuer/type/audience/client/signed grant ID/scope/times. Cognito login tokens and service access tokens remain distinct.
- **FR-003**: Require current billing-owned paid entitlement before successful application login, token issuance or refresh; identity verification alone cannot log the user in. Missing/denied/expired/malformed/unavailable evidence fails closed; distinguish subscription-required from retryable-unavailable outcomes. Authorizer validates tokens without grant, subscription or binding reads.
- **FR-004**: Permit billing management only with current valid paid entitlement and verified own-account ownership; deny billing disclosure, invoices, portal/payment-method access, plan changes and cancellation otherwise, including via old links/sessions. Unpaid users may only verify identity, purchase/renew and inspect that purchase through a bounded enrollment continuation; this is not application login.
- **FR-005**: Own REST API/named stage/deployment/logging, REQUEST binding, methods/integrations/permissions and native usage plans through repository IaC.
- **FR-006**: Create REST separately from legacy HTTP; use controlled endpoint cutover/rollback without automatic takeover, replacement or deletion.
- **FR-007**: Scope policies/permissions to exact account/API/stage/function; prevent bypasses. Authorizer has scoped logs and trusted JWKS access, no datastore, signing, provisioning or billing permissions.
- **FR-008**: Use current reads for login, management, issuance and refresh; revocation blocks new credentials while issued access remains valid until expiry. Authorizer decision caching stays disabled; MCP readiness remains independent.
- **FR-009**: Document connection, refresh/logout/revocation bounds, deployment/migration, rollback and retention; preserve compatible identities.
- **FR-010**: Exclude credentials, verifiers and raw keys/private claims from logs, infrastructure outputs and evidence; the signed token intentionally exposes its subscriber usage key to its holder. Callback URLs carry only permitted OAuth response fields; distinguish identity/entitlement/activation/configuration failures.
- **FR-011**: Retain identity/access/gateway state by default; service cleanup preserves access/billing. Destructive access cleanup requires explicit ownership scope.
- **FR-012**: Keep component releases/data/evidence independent and provisioning acyclic; MCP receives no identity/billing/signing credentials or permissions.
- **FR-013**: Bind a bounded transaction across login/payment. After trusted activation, return one-use code/state/issuer; redeem against PKCE/client/redirect/resource. Never return bearer/refresh tokens in callbacks.
- **FR-014**: Issue signed resource/client/grant/identity-bound access tokens containing `usageIdentifierKey`, plan and paid validity; access expires at min(issuance + 1 hour, subscription expiry). Rotating refresh credentials expire at subscription expiry, recheck current authority and reject replay; rotation never extends that deadline.
- **FR-015**: Expose discovery/OAuth/callback/token/JWKS/onboarding without a paid-key gate. Missing/invalid MCP credentials produce upstream 401 resource metadata; ineligible access is denied before MCP.
- **FR-016**: Assign one private native key per subscriber and matching tier/stage. Use AUTHORIZER key source, required paid-method keys and top-level `usageIdentifierKey` copied from the validated signed claim, not a header; clients send bearer only. Provision outside authorization; unready bindings block issuance/refresh.
- **FR-017**: Make tier rates/bursts/quotas explicit inputs; native request limits are best effort, not strict billing credits/cost caps.
- **FR-018**: Validate purchase/reconnect, payment failures/delays, refresh/replay, plan/expiry, subscriber isolation and real host interoperability separately from local fixtures.
- **FR-019**: Implement onboarding in Node.js/Express with durable DynamoDB transitions, short event handlers and scheduled recovery; use no Step Functions. Requests/invocations never wait through human/payment delays or rely on background work after return.
- **FR-020**: Commit verified decisions and required durable work before notification; use conditional transitions, idempotent effects and recoverable leases to handle early/duplicate/reordered/uncertain/stale callbacks without lost activation or cross-user/duplicate effects.
- **FR-021**: Preserve absolute expiry and paid billing state through crashes/cancellation/retries/replay; recover missed events and abandoned leases without an open browser. Restrict state/work access, exclude secrets from events/logs, and support existing records across releases/rollback.

## Key entities

Verified Cognito identity; bound OAuth transaction; versioned onboarding state/durable work; client grant/revocation; service access token; billing entitlement; private subscriber usage binding; exact-method decision; endpoint cutover record. Field contracts live in the linked design documents.

## Success criteria

- **SC-001**: Paid users meeting readiness checks can log in; all ineligible/unverifiable login cases produce zero successful application logins or service credentials; denied service requests invoke MCP zero times.
- **SC-002**: Unpaid purchase/renewal works without premature login; every invalid-subscription or cross-account billing case discloses zero billing records and causes zero management effects; eligible reconnect creates no purchase.
- **SC-003**: Distinct-endpoint migration/rollback preserves legacy resources and identities.
- **SC-004**: Committed plan/eligibility changes affect the next login/management/issuance/refresh; revoked refresh returns `invalid_grant`, while existing access lasts at most 1 hour and never past its signed subscription expiry.
- **SC-005**: Evidence separates simulation from real host/identity/gateway/payment/retention checks; missing live checks cannot establish readiness.
- **SC-006**: Simulated purchase/reconnect completes once; tampered/replayed/cancelled/expired/unverified-payment flows issue zero unauthorized grants.
- **SC-007**: Same-tier subscribers have distinct metering identities; issuance/refresh after plan changes cannot use stale ready bindings; outstanding access follows SC-004.
- **SC-008**: Supported hosts discover and complete OAuth without manual usage-key headers or bearer callback URLs.
- **SC-009**: Early/duplicate/reordered/late/mismatched/failed callback delivery preserves progress with zero duplicate purchases/unauthorized grants and no HTTP/worker wait through payment.
- **SC-010**: Crash/cancellation/retry/replay preserves expiry and paid state; missed-event/lease recovery completes with the browser closed, and evidence distinguishes live delivery from simulation without credentials.

## Assumptions and references

Purchase-only enrollment preserves first purchase and renewal without granting application login or general billing management. Eligibility policy belongs to [billing FR-007](../003-billing-subscriptions/spec.md#functional-requirements). Initial clients are explicitly registered public clients; CIMD/DCR and other capabilities require implementation before advertisement. Operators supply exact callbacks/client IDs, account/region/stage and tier limits. WAF defaults, baseline protection and the separate enablement decision are defined in the [REST gateway contract](contracts/rest-gateway.md#waf-and-baseline-protection). Lifetimes and signing/storage choices are technical defaults in the contracts. Local-only testing remains in force; no AWS/Stripe changes or charges are implied. The adopted constitution governs revisions.

[Endpoints](contracts/endpoints.md) · [Plan](plan.md) · [Tasks](tasks.md) · [Client flow](contracts/client-onboarding.md) · [Workflow](contracts/onboarding-workflow.md) · [Authorization](contracts/authorization.md) · [REST gateway](contracts/rest-gateway.md)
