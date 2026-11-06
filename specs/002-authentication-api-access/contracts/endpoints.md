# Contract: Access Endpoint and Browser Handoff

**Status**: Planned routes, not implemented or deployed. Paths below are relative to the configured access base URL, including its named gateway stage or domain mapping. Issuer/resource/callback URLs are exact deployment inputs; discovery locations follow the client contract. Billing behavior belongs to spec 003; this document fixes HTTP routing and caller boundaries.

## HTTP surface

Discovery and login/onboarding/billing protocol routes require no existing paid MCP bearer/key; their session, ownership, CSRF and signature checks still apply. `/mcp` and gateway `/health` are protected, as marked below.

| Method/path | Caller → handler | Validation and response |
|---|---|---|
| GET resource-metadata URL | AI backend → access | Public JSON identifying the canonical MCP resource and authorization-server issuer; advertised by the MCP 401 challenge. |
| GET authorization-server discovery URLs | AI backend → access | Public JSON containing exact issuer, authorization/token/JWKS endpoints and only supported capabilities; see client discovery contract. |
| GET `/jwks.json` | JWT verifier → access | Public service signing keys only, never private signing material. |
| GET `/authorize` | Browser → access | Validate registered client/exact redirect/resource/scopes/state/S256 challenge; persist an expiring pending transaction and separate upstream state/nonce/PKCE; 302 to Cognito authorization. No authenticated user or MCP token is assumed. |
| GET `/oauth/cognito/callback` | Browser redirected by Cognito → access | Match unexpired upstream state; exchange Cognito code server-side with its PKCE verifier; validate tokens/nonce and bind verified identity; 303 to own onboarding page. Never send Cognito's code to the AI host. |
| GET `/onboarding` | Browser → access | Bounded session renders plan selection, pending/activation/error progress or a completion form for an already-eligible subscriber. |
| GET `/onboarding/status` | Browser → access | Session-bound own transaction/order status; no-store JSON, no codes/tokens/keys; bounded polling with backoff stops on ready/terminal/expired state. |
| POST `/onboarding/resume` | Browser form → access | Require session/CSRF and current transaction, entitlement and ready binding; atomically issue one-use code; 303 to registered AI callback with code, original state and issuer. Pending returns non-success readiness status without a code; expired requires fresh authorization. |
| POST `/token` | AI backend → access | Form-encoded code or refresh exchange defined in authorization contract; noncacheable token response directly to AI backend, not a browser redirect. |
| GET `/billing/plans` | Browser → access → billing IAM operation | Verified bounded identity continuation; approved catalog only. |
| POST `/billing/checkout` | Browser → access → billing IAM operation | Continuation/CSRF, approved plan and own-order idempotency; create/reuse Checkout and 303 browser to Stripe's returned URL. |
| GET `/billing/orders/{orderId}` | Browser → access → billing IAM operation | Verified own-order continuation; sanitized payment/activation status, never client-supplied success authority. |
| GET `/billing/return` | Browser redirected by Stripe → access | Configured success/cancel destination, opaque own-order correlation and bounded session; render progress and poll own backend, not Stripe; no payment mutation from query parameters. |
| POST `/billing/subscriptions/{subscriptionRef}/manage` | Browser → access → billing manageSubscription | Current-paid eligibility, session/CSRF, exact own subscription and explicit action allowlist; pending/confirmed management result, no arbitrary customer/price input. |
| POST `/billing/portal` | Browser → access → billing IAM operation | Current paid eligibility, session/CSRF and own-account checks; redirect only to approved Stripe management session under billing policy. |
| POST `/webhooks/stripe` | Stripe backend → billing directly | Verify signature over exact raw body and trusted event/payment state; commit billing/outbox before acknowledging Stripe; never issue OAuth codes or redirect the user. |
| POST `/logout` | Browser → access | Session/CSRF; revoke own refresh grant and clear browser session; access JWT lifetime remains bounded by authorization contract. |
| POST `/revoke` | Client backend → access | RFC 7009 refresh-token revocation for the registered public client; enforce stored client/grant ownership without trusting supplied identity; no token disclosure. |
| `/mcp` transport methods; GET `/health` | AI/authorized monitoring → gateway authorizer → MCP | Validate service JWT; AUTHORIZER usage key and exact policy; missing/invalid token gets 401 metadata challenge. Internal MCP liveness remains separate. |

## Browser versus backend completion

Stripe returns the browser to `/billing/return`; its signed webhook is a separate server-to-server request and can arrive first or later. Payment/usage-binding activation progresses without an open page. The return page renders verified status, then submits a normal top-level POST form to `/onboarding/resume`; JavaScript fetch redirects alone do not navigate the browser. Eligible subscribers use the same completion form without Checkout.

The 303 Location carries the code through the browser to the AI client's registered callback. The AI backend then exchanges it at `/token`; your backend does not push codes directly to that backend. No access/refresh token enters redirect URLs. Exact redirect/state/issuer matching and replay guards follow client/authorization contracts. Closing the page prevents delivery, not payment; an unexpired bound session can resume, otherwise fresh authorization reuses the paid subscription without repurchase.

DynamoDB stores pending connection details before identity verification, then binds identity only after validated Cognito completion. Check deadlines in code even before TTL deletion; configure TTL for disposable transaction records, with separate retention for grants/revocation/work. Expiry must never delete or undo billing state.

## Implementation acceptance

Exercise discovery-to-code exchange, separate Cognito/AI callbacks, current-paid skip-Checkout, webhook-before/after-browser return, duplicate webhooks/resume, no code from webhook, real top-level 303 navigation, closed-page recovery, expired transactions before TTL deletion, both `/token` grant types, ownership/CSRF failure and secret-free responses/logs. Test native gateway stage/domain mappings and both real AI hosts separately; local fixtures do not prove live interoperability.
