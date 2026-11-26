# Contract: Cognito Identity, Service Tokens and REST Authorizer

**Status**: Local JWT verification/signing and OAuth/token flows implemented with simulated adapters; package, deployment and live acceptance remain pending. This supersedes the direct-Cognito-bearer/HTTP-authorizer contract. The [client flow](client-onboarding.md) is authoritative for OAuth completion.

## Separate identity and service issuers

Cognito managed login uses a public app client, authorization code + S256 PKCE, no client secret. Create mode retains a pool/client/domain. Self-registration is enabled so first sign-in can create the user, and the only identity providers are Cognito and one Google federation (OIDC, operator-owned Google OAuth client, secret held outside templates). Compatible reuse checks the whole pool/client/domain and callback/scopes configuration without resetting users, taking ownership or changing policies silently. Additional providers or client flows need explicit design changes. Cognito callback/logout URLs are exact operator inputs for the coordinator, not guessed AI-host callbacks.

The coordinator validates upstream Cognito signature/algorithm/key/issuer, ID-token audience/nonce and access-token client/type/time/scope as applicable before accepting the login. Only verified immutable Cognito issuer/subject determines billing ownership. Email never establishes ownership. Cognito signing keys and upstream JWT claims are distinct from downstream service signing keys and claims. Application code cannot mint Cognito JWTs or lengthen their expiry.

The coordinator issues its own asymmetric RS256 service JWT (header typ=at+jwt with an opaque kid) signed through AWS KMS (`kms:Sign`, RS256; see Signing-key storage below), exact issuer and MCP resource audience. Required claims are `iss`, `sub` (access-owned stable identity handle), `aud`, `client_id`, `grant_id`, `scope`, `iat`, `nbf`, `exp`, `jti`, `token_use=access`, `plan_id`, `subscription_valid_until`, and `entitlement_revision`, and nonempty string `usageIdentifierKey` (the native subscriber key value). Grant state binds the handle to upstream issuer/subject, registered client and resource. The signed payload intentionally exposes the usage key to the token holder; changing it invalidates the signature. Do not expose Stripe IDs or full upstream claims, or log/export tokens or keys. Configure AUTHORIZER key source so the visible key alone cannot bypass bearer authorization. Expiry is the earlier of issuance plus one-hour TTL and current entitlement validity; validate ordering/types and limited clock skew (at most 30 seconds, never extend the subscription bound). Only `/token` returns bearer/refresh credentials; callbacks return codes.

Retained access DynamoDB stores hold bounded OAuth transactions, client/grant/revocation state, durable work and subscriber bindings separately from billing projections. Codes/refresh credentials are hashed and atomically consumed/rotated. Coordinator endpoints own session/grant state, selected-key signing and exact billing IAM invocation. The same access Lambda performs bounded provisioning during onboarding HTTP requests; it has no queue or replay handler, and token routes only issue credentials after current readiness. The [onboarding contract](onboarding-workflow.md) defines leases, current-state checks, deadlines and recovery. Access has no billing writes or Stripe credentials. Explicitly minimize API Gateway management actions/resource scopes; key operations are not all API-ID scoped.

Access record keys, digests, replay tombstones and atomic code/refresh transactions follow [access storage](access-storage.md).

## Signing-key storage, cache and rotation

Sign service JWTs with a retained RSA 2048 AWS KMS key (`SIGN_VERIFY`, alias `alias/mcp-access-signing`) created by `infra/access/signing.yaml`. CloudFormation creates the key, so no operator generates, uploads or sees private key material. The coordinator configures only the exact key ARN, the public `kid` and the public JWK (`n`, `e`) that KMS reports for that key, and never accepts key locations from requests. Each token signs a SHA-256 digest of the JWS signing input with `kms:Sign` (`RSASSA_PKCS1_V1_5_SHA_256`, `MessageType` `DIGEST`); the returned signature is placed unchanged in the `at+jwt` token. Before signing, the coordinator checks `kms:GetPublicKey` against the configured public JWK and fails closed on any mismatch.

Cache only the public-key verification result, in each Lambda execution environment's memory and never on disk or in application DynamoDB, for at most 300 seconds; then repeat `GetPublicKey` and the JWK match. No private material exists in application memory. Concurrent checks share one three-second attempt, and each `kms:Sign` call has the same three-second deadline. A mismatched, unavailable or expired key check fails issuance closed without credentials, so a failed refresh of an expired check does not permit indefinite use. KMS outages do not stop verification of already-issued JWTs against trusted public keys.

The access runtime role alone receives `kms:Sign` on the exact key ARN, conditioned on `kms:SigningAlgorithm` = `RSASSA_PKCS1_V1_5_SHA_256`, and `kms:GetPublicKey` on the same ARN. The key policy delegates to IAM for account administration only. No signing grants exist for authorizer, MCP or billing. HTTP token/provisioning handlers share the access function role, so signing isolation is not claimed between them. Public JWKS publishing uses the public JWK from configuration and needs no KMS permission. Disabling the key or removing the grant stops new issuance; already-issued JWTs stay verifiable until `exp`.

Rotation creates a new KMS key, publishes its public JWK before switching the configured key ARN and `kid`; pin compatible pairs and verify their match before issuance. Roll or refresh all signer instances and record the last possible old-key issuance, accounting for cache and deployment overlap. Retain old public keys for at least the maximum access lifetime plus permitted clock skew after that point. Rollback must preserve verifiability of all unexpired tokens. Test cold/warm cache behavior, concurrent retrieval, cache expiry/outage, denied IAM, malformed keys, key/kid mismatch and overlapping rotation/rollback; no key material enters fixtures or reports.

## REQUEST authorizer

A separately packaged TypeScript/Node.js ARM64 Lambda uses the managed Node.js 24.x runtime and an immutable ZIP artifact containing compiled handler/shared modules and isolated npm-locked production dependencies; it does not use a container image or Docker deployment. REST REQUEST events use `methodArn`, not HTTP API payload-2.0 `routeArn`. Validate the allowed method and path against the route list (the account, region, API and stage are not checked; see the 2026-11-26 amendment), one bounded well-formed Bearer header, RS256/kid, service issuer/audience/client/type/scope, times and trusted JWKS. Never fetch token-supplied key URLs. JWKS cache is bounded to 300 seconds, fetch to three seconds and one unknown-kid refresh with bounded negative caching; unavailable trustworthy keys fail closed.

Before token issuance and every refresh, the coordinator uses current strongly consistent grant/revocation, [billing entitlement](../../003-billing-subscriptions/contracts/entitlements.md) and subscriber-binding reads: matching identity/client/resource, unrevoked grant, allowed future entitlement, recognized current plan/revision and enabled ready stage binding. Unavailable or mismatched state blocks issuance. The authorizer performs no datastore/subscription/binding lookup; require valid signed claims, a nonempty string `usageIdentifierKey`, `exp <= iat + 3600` and `exp <= subscription_valid_until`. Missing, malformed, tampered or expired tokens deny before MCP. Signed plan/revision claims are issuance snapshots, not current-state guarantees.

Return `principalId`, an IAM `policyDocument` scoped to the exact allowed request method ARN, minimal nonpersonal context, and top-level `usageIdentifierKey` equal to the validated token's `usageIdentifierKey` claim. No wildcard Allow and no key in context/logs; return the key only to API Gateway, not an injected header. Configure REST identity source `method.request.header.Authorization`, TTL 0, API `ApiKeySourceType=AUTHORIZER`, paid methods `AuthorizationType=CUSTOM` and `ApiKeyRequired=true`. No payload-format/simple-response fields belong on this REST authorizer. Gateway owns exact authorizer-alias invocation permission with SourceAccount.

The authorizer role has only scoped log writes, required X-Ray telemetry export and trusted JWKS retrieval, with no DynamoDB access. It cannot sign tokens, manage keys/plans, write billing/access state, call Stripe or read MCP provider credentials. The service role remains log-only. Token validation and refresh decisions remain synchronous; refresh requires current readiness. Identity verification can establish only the purchase-only continuation defined in [FR-004](../spec.md#functional-requirements); application login and management require current paid eligibility. Coordinator and billing handlers check this on each management operation, including existing sessions/links.

## Token and revocation requests

`POST /token` accepts `application/x-www-form-urlencoded` and dispatches on `grant_type`. `authorization_code` requires code, well-formed `client_id`, exact `redirect_uri`, original `code_verifier` and bound MCP `resource`; atomically consume the code and recheck current authority. `refresh_token` requires the opaque credential and registered client binding; any supplied resource/scope must match or narrow the stored grant, never expand it. Neither exchange accepts browser identity or Cognito tokens as a substitute. Missing/unsupported grant types and invalid code/refresh inputs return appropriate OAuth errors without credentials. Return tokens as JSON directly to the AI backend, never a redirect; use `Cache-Control: no-store` and `Pragma: no-cache`.

`POST /revoke` accepts a form-encoded refresh `token`, registered `client_id` and optional `token_type_hint=refresh_token`; public clients have no fabricated shared secret. Validate the token's stored client ownership and revoke its family; unknown or already revoked tokens return RFC 7009 non-disclosing success. This does not invalidate locally verified access JWTs or revoke Cognito tokens. Browser logout uses the separate session/CSRF operation in the [endpoint contract](endpoints.md).

## Denial and revocation

Missing/bad credentials produce an upstream 401 with the correct resource-metadata challenge via REST GatewayResponses; valid tokens lacking the required route scope return 403. Unexpected infrastructure/authorizer errors are diagnosed separately and never counted as evidence of correct credential rejection. Authorizer decision caching is disabled. Opaque hashed refresh credentials rotate atomically and expire at the subscription expiry recorded at initial issuance; rotation cannot extend that deadline. Renewal requires a fresh authorization grant to acquire a later refresh deadline. Revoking a grant/refresh family, or ending paid eligibility, blocks subsequent refresh with OAuth `invalid_grant`; unavailable state returns a retryable error without tokens. Logout invalidates its browser session and revokes an owned refresh family when present; direct management does not require an MCP refresh family. Already-issued access tokens remain valid until `exp`, at most 1 hour after issuance. Cognito logout/revocation does not invalidate locally verified service JWTs. No automatic renewal occurs; expired users must explicitly purchase a new term through onboarding. Current-term cancellation is support-assisted under billing policy; immediate eligibility revocation disables refresh but does not immediately invalidate access JWTs. Token responses include `access_token`, `token_type=Bearer`, remaining `expires_in`, and rotated `refresh_token`, with no-store headers. ChatGPT/Claude refresh and reconnect behavior must be verified live; a failed refresh requires reauthorization, not a guaranteed automatic login prompt, and ineligible re-login is denied.

The MCP process validates no JWT and requires no OAuth, DynamoDB, Stripe or signing SDK/environment/IAM grant. Its internal `/health` remains independent.

## Sources

[REST authorizer inputs](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-lambda-authorizer-input.html), [authorizer output and usageIdentifierKey](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-lambda-authorizer-output.html), [Cognito token validation](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html). Exact TTLs, issuer-side state reads and coordinator signing are project design decisions.


## Amendment: open client registration (2026-11-25)

The approved decision is that any client may start a sign-in. The static client registry is removed: there is no client allow-list, no per-client redirect list and no per-client scope list.

What remains, enforced on every request:
- `client_id` must be a well-formed identifier. The token's `client_id` claim must match the same format.
- `redirect_uri` must be an HTTPS URL without credentials, fragment or wildcard. The authorization code is bound to the exact `redirect_uri` it was issued for, and `/token` refuses any different value.
- PKCE with `S256` is required, and the authorization code is single-use and bound to the client that obtained it.
- Requested scopes must be within `openid` and `mcp:invoke`. The access token carries the granted scopes, and the authorizer checks the MCP scope on each route.
- Cognito still authenticates the user, and billing still decides whether a subscription is active.

Accepted risk, recorded by the owner: a user who signs in through an unfamiliar app can have a token issued to that app, and that token carries the subscriber's usage key. Detection is by logging `client_id` on issuance and monitoring. Restricting which clients may use the service is a later, separate decision and will need its own amendment.

## Amendment: authorizer does not validate the API or stage (2026-11-26)

The approved decision is that the REST authorizer does not check the request's account, region, REST API ID or named stage. The authorizer is attached to one REST API, and API Gateway invokes it only for that API's requests, so the check guarded only against an accidental reuse of the authorizer on another API or stage. It also made the authorizer depend on the gateway's REST API ID, which is created after the authorizer alias that the gateway needs at deploy time.

What remains, enforced on every request:
- One bounded, well-formed Bearer header; RS256 `kid`; trusted JWKS only.
- Service issuer, audience, client, token type, scope, times and `usageIdentifierKey` checks, as before.
- The request's method and path must match the route list, and the route's scope must be present in the token. The route list is authorizer configuration.
- The returned policy allows only the exact request method ARN. No wildcard Allow.

The authorizer config no longer carries `accountId`, `region`, `apiId` or `stage`. The REST API ID and stage still exist and are still published by the gateway for usage-plan provisioning, and the gateway still pins alias invocation permissions to the exact API, stage and method.

This supersedes the account/region/API/stage validation in the authorizer paragraph above.
