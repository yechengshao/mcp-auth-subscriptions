# Contract: Access Endpoint and Browser Handoff

**Status**: Endpoint contract; core OAuth/onboarding routes have local implementations and tests, but nothing is deployed. Paths below are relative to the configured access base URL, including its named gateway stage or domain mapping. Issuer/resource/callback URLs are exact deployment inputs; discovery locations follow the client contract. Billing behavior belongs to spec 003; this document fixes HTTP routing and caller boundaries.

## HTTP surface

Discovery and login/onboarding/billing protocol routes require no existing paid MCP bearer/key; their session, ownership, CSRF and signature checks still apply. `/mcp` and gateway `/health` are protected, as marked below.

| Method/path | Caller → handler | Validation and response |
|---|---|---|
| GET resource-metadata URL | AI backend → access | Public JSON identifying the canonical MCP resource and authorization-server issuer; advertised by the MCP 401 challenge. |
| GET authorization-server discovery URLs | AI backend → access | Public JSON containing exact issuer, authorization/token/JWKS endpoints and only supported capabilities; see client discovery contract. |
| GET `/jwks.json` | JWT verifier → access | Public service signing keys only, never private signing material. |
| GET `/billing` | Browser → access | Valid management session plus current-paid ownership renders the current term and approved upgrade choices; missing/expired session redirects to fixed `/login`; no private details for ineligible users. |
| GET `/login` | Browser → access | Start management-purpose context with the shared session mechanism; redirect to Cognito; fixed local return only, no MCP grant or arbitrary redirect. |
| GET `/authorize` | Browser → access | Validate registered client/exact redirect/resource/scopes/state/S256 challenge; persist an expiring pending transaction and separate upstream state/nonce/PKCE; 302 to Cognito authorization. No authenticated user or MCP token is assumed. |
| GET `/oauth/cognito/callback` | Browser redirected by Cognito → access | Match unexpired upstream state; exchange Cognito code server-side with its PKCE verifier; validate tokens/nonce and bind verified identity; 303 to `/onboarding` for OAuth purpose or fixed `/billing` for management purpose. Never send Cognito's code to the AI host. |
| GET `/onboarding` | Browser → access | Bounded session renders plan selection, pending/activation/error progress or a completion form for an already-eligible subscriber. |
| POST `/onboarding/status` | Browser → access | Session/CSRF-bound own transaction/order status plus bounded due provisioning; no-store JSON, no codes/tokens/keys; bounded polling with backoff stops on ready/terminal/expired state. |
| POST `/onboarding/resume` | Browser form → access | Require session/CSRF and current transaction/entitlement; advance bounded due provisioning, then require binding ready under the REST configuration-success rule, without propagation probing; atomically issue one-use code; 303 to registered AI callback with code, original state and issuer. Pending returns non-success readiness status without a code; expired requires fresh authorization. |
| POST `/token` | AI backend → access | Form-encoded code or refresh exchange defined in authorization contract; noncacheable token response directly to AI backend, not a browser redirect. |
| GET `/billing/plans` | Browser → access → billing IAM operation | Verified bounded identity continuation; approved tiers/duration options and display prices only. |
| POST `/billing/checkout` | Browser → access → billing IAM operation | Continuation/CSRF, approved plan/duration/catalog version and own-order idempotency; persist own order/reconciliation work, create/reuse Checkout, schedule delayed BillingReconcileQueue checking under the delivery contract, then 303 browser to Stripe's returned URL. |
| GET `/billing/orders/{orderId}` | Browser → access → billing IAM operation | Verified onboarding or management session bound to that exact order; sanitized payment status only, never client-supplied success authority. |
| GET `/billing/return` | Browser redirected by Stripe → access | Configured success/cancel destination and verified bounded browser session; render progress and poll the service, not Stripe; onboarding resumes OAuth while management prepares the changed binding; no payment mutation from query parameters. |
| POST `/billing/status` | Browser → access → billing and usage-binding services | Management session/CSRF; verify any saved own upgrade order, then prepare or reuse the current entitlement binding in a bounded request. Returns payment/activation status without issuing OAuth codes. |
| POST `/billing/subscriptions/{subscriptionRef}/manage` | Browser → access → billing IAM operation | Require current-paid management session, same-origin CSRF, and an exact match to the `subscription_id` in the billing-owned entitlement projection. `action=quote_upgrade` carries only target plan/duration/catalog IDs; Access supplies current source revision. `action=confirm_upgrade` carries the server-issued quote ID and redirects to Stripe only after Billing returns a validated Checkout URL. Downgrade/cancel/refund and nonpositive/ambiguous credit return outcome=support_required with a reason code and configured support email, with no financial mutation or Checkout. |
| POST `/billing/portal` | Browser → access → billing IAM operation | Current paid eligibility, session/CSRF and own-account checks; disabled in the initial release: no portal escape path for prohibited downgrade/cancellation/refund; show configured support email instead. |
| POST `/webhooks/stripe` | Stripe backend → billing directly | Verify signature over exact raw body and trusted event/payment state; commit billing/outbox before acknowledging Stripe; never issue OAuth codes or redirect the user. |
| POST `/logout` | Browser → access | Session/CSRF; invalidate/clear current browser session and revoke its owned refresh family if one exists; access JWT lifetime remains bounded by authorization contract. |
| POST `/revoke` | Client backend → access | RFC 7009 refresh-token revocation for the registered public client; enforce stored client/grant ownership without trusting supplied identity; no token disclosure. |
| `/mcp` transport methods; GET `/health` | AI/authorized monitoring → gateway authorizer → MCP | Validate service JWT; AUTHORIZER usage key and exact policy; missing/invalid token gets 401 metadata challenge. Internal MCP liveness remains separate. |

## Browser versus backend completion

Stripe returns the browser to `/billing/return`; its signed webhook is a separate server-to-server request and can arrive first or later. Billing payment confirmation progresses without an open page; binding activation advances only on status/resume or fresh-login requests. For OAuth onboarding, the return page submits a normal top-level POST form to `/onboarding/resume`; JavaScript fetch redirects alone do not navigate the browser. For a paid plan upgrade, the management status POST advances the same key to the new usage-plan association, then leaves the user on subscription management without issuing a new OAuth code. A later management login can also reconcile a changed entitlement if the return page was closed.

The 303 Location carries the code through the browser to the AI client's registered callback. The AI backend then exchanges it at `/token`; your backend does not push codes directly to that backend. No access/refresh token enters redirect URLs. Exact redirect/state/issuer matching and replay guards follow client/authorization contracts. Closing the page prevents delivery, not payment; an unexpired bound session can resume, otherwise fresh authorization reuses the paid subscription without repurchase.

DynamoDB stores pending connection details before identity verification, then binds identity only after validated Cognito completion. Check deadlines in code even before TTL deletion; configure TTL for disposable transaction records, with separate retention for grants/revocation/work. Expiry must never delete or undo billing state.

## Activation error responses

Failed AWS key/association calls, timeouts or failed local persistence return a non-2xx activation error with stable error_code, safe message, retryable flag, opaque correlation reference and retry/reconnect guidance; use 503 with Retry-After for transient dependency failures and 500 for permanent server configuration/permission defects with a support action. Never return raw AWS errors, key values or provider payloads. A timeout is an error to the user but may be an uncertain effect internally; the next request reconciles persisted/native state before repeating work. Retain paid entitlement and never create another order as error recovery. An AWS call failure is not merely a normal payment-pending response; pending remains valid for payment not yet verified, another active lease or a retry not yet due. Only successful AWS configuration plus a matching persisted binding permits code/token issuance.

UI shows the retry action on setup failure and honors backoff. Expired continuation redirects to fresh authorization; it does not erase payment. A permanent server defect cannot be fixed by repeated login, so retain the same safe recovery flow with support guidance instead of an endless retry spinner.

## Implementation acceptance

Exercise discovery-to-code exchange, separate Cognito/AI callbacks, current-paid skip-Checkout, webhook-before/after-browser return, duplicate webhooks/resume, no code from webhook, real top-level 303 navigation, closed-page recovery, expired transactions before TTL deletion, both `/token` grant types, ownership/CSRF failure and secret-free responses/logs. Test native gateway stage/domain mappings and both real AI hosts separately; local fixtures do not prove live interoperability.

Browser billing JSON status/error-code mapping follows the [canonical billing result contract](../../003-billing-subscriptions/contracts/storage-operations.md#native-operation-envelope); OAuth and webhook responses keep their own protocol rules.

Onboarding and management share the [same browser-session mechanism](browser-sessions.md), 30-minute absolute expiry and Cognito reauthentication; neither creates a separate long-lived management token or reuses a ChatGPT bearer token in the browser.
