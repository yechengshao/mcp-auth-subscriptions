# Authentication and API access: operator guide

This guide describes how the access service is bootstrapped, how the paid-host flows
work, what bounds apply to tokens and revocation, how recovery and rollback behave,
and how the REST cutover is performed. It is the operator companion to the
authoritative contracts in `specs/002-authentication-api-access/contracts/`. Where
this guide and a contract disagree, the contract wins and this guide must be fixed in
the same change.

Every step that has not been performed in a cloud account or with a payment provider
is listed in [Status of cloud and provider steps](#status-of-cloud-and-provider-steps).
Local verification results are never evidence of live behavior.

## Components

| Component | Source | Owns |
|---|---|---|
| Cognito identity (`mcp-access-auth`) | `infra/access/auth.yaml` | Upstream login, Google federation, PKCE public client |
| Signing key (`mcp-access-signing`) | `infra/access/signing.yaml` | Retained RSA 2048 KMS key `alias/mcp-access-signing` |
| Access runtime | `infra/access/runtime.yaml`, `access/` | OAuth, sessions, tokens, onboarding and management routes |
| Authorizer | `infra/access/authorizer.yaml`, `authorizer/` | REST REQUEST authorizer: verifies service JWTs only |
| REST gateway | `infra/access/gateway.yaml` | Methods, stage, paid API-key gate, deployment |
| Billing | `specs/003-billing-subscriptions/` | Stripe, orders, entitlements, webhook |

The access service never writes billing data and never holds Stripe credentials. It
calls billing only through the exact billing Lambda alias for checkout, order status,
plan listing, upgrades and the billing portal, and reads entitlements directly from
the billing entitlement table.

## Bootstrap order

Follow [quickstart](../specs/002-authentication-api-access/quickstart.md) for the full
sequence. The order that matters for dependencies is:

1. **Identity.** Deploy `infra/access/auth.yaml` with the registered callback and
   logout URLs for the coordinator. The Google client secret is a `NoEcho` deploy
   input, never a template value.
2. **Signing key.** Deploy `infra/access/signing.yaml`. Read `SigningKeyArn` from
   its output. Derive the public JWK with `aws kms get-public-key --key-id <arn>`
   and convert the DER SubjectPublicKeyInfo to a JWK. The public key is not secret,
   and the runtime pins it.
3. **Storage.** Deploy `infra/access/storage.yaml` (access tables) and the billing
   storage that the entitlement table lives in.
4. **Billing alias.** Deploy billing with its live alias. Access cannot invoke it
   until the alias exists.
5. **Access runtime.** Deploy `infra/access/runtime.yaml` with `SigningKeyArn`, the
   billing alias ARN, the table ARNs, and the four JSON inputs:
   `AccessConfigJson`, `PublicJwksJson`, `SigningConfigJson` (`keyArn`, `kid`,
   `publicJwk`), and `ProvisioningConfigJson`. The runtime refuses to start without
   the signing and billing configuration.
6. **Authorizer.** Deploy `infra/access/authorizer.yaml` from the published ZIP with
   the trusted `JwksUri` (`/jwks.json` on the access service).
7. **Gateway.** Deploy `infra/access/gateway.yaml` with the service, access,
   billing webhook and authorizer alias ARNs, the metadata URL, and the stage name.
   Native usage plans come from access provisioning, not from this template.

Each template is validated by `cfn-lint` in CI before deployment. Deploy inputs come
from the publication workflows, never from local shells.

## Signing and key rotation

- The coordinator signs RS256 JWTs with `kms:Sign` over a SHA-256 digest of the JWS
  signing input. The private key never leaves KMS.
- Before each signing, the coordinator checks `kms:GetPublicKey` against the pinned
  `publicJwk` and fails closed on mismatch. The check is cached for at most 300 seconds.
- Rotation: create a new key stack, publish its public JWK alongside the old one in
  `PublicJwksJson`, then switch `SigningConfigJson` to the new `keyArn` and `kid`.
  Keep the old public key published until every token it signed has expired (one hour
  plus the permitted clock skew).
- Rollback: switch the configuration back. The retained KMS key remains usable, so
  unexpired tokens stay verifiable.

## Onboarding and management flows

Both flows use the same browser session: a cookie, a 30-minute absolute expiry and
Cognito reauthentication on expiry. Neither flow hands the AI client's MCP token to the
browser.

- **Onboarding.** An AI client's `/authorize` request is validated against the
  registered client, redirect URI, resource and S256 challenge. The browser signs in
  through Cognito, chooses a plan, and pays on Stripe. Stripe returns the browser to
  `/billing/return`. The signed Stripe webhook arrives separately, to billing, and can
  come before or after the browser. The browser completes the flow by submitting a
  form to `/onboarding/resume`, which issues one one-use code and redirects to the
  client's registered callback.
- **Management.** `/billing` shows the current term. Upgrades are quoted and then
  confirmed, and Stripe redirects to checkout only after billing returns a validated
  URL. Downgrades, cancellations, refunds and ambiguous credits return
  `support_required`. The billing portal is disabled.
- **Paid-plan activation.** Activation is bounded, idempotent provisioning. Status
  and resume requests advance it; a fresh login can also reconcile it. A failed
  provisioning step returns a retryable error and never creates another order.

The AI client exchanges the code at `POST /token` directly. The code never goes to the
client through a redirect other than the registered callback.

## Token and revocation bounds

| Item | Bound |
|---|---|
| Access JWT lifetime | At most 3600 seconds after issuance, and never past `subscription_valid_until` |
| Clock skew | At most 30 seconds in validation; the coordinator uses 5 seconds |
| Refresh credential | Opaque, hashed, rotated atomically, expires at the subscription expiry recorded at first issuance; rotation cannot extend it |
| Revoking a refresh family | `POST /revoke` (RFC 7009, non-disclosing) or `POST /logout` (browser session) |
| Effect on access JWTs | Revocation does not invalidate locally verified access JWTs; they remain valid until `exp` |
| Eligibility end | Blocks refresh with `invalid_grant`; does not invalidate access JWTs before `exp` |
| JWKS cache (authorizer) | At most 300 seconds; fetch timeout 3 seconds; one refresh per unknown `kid`, at most every 30 seconds; 30-second negative cache |
| Authorizer decisions | Not cached (TTL 0) |

Expired subscriptions are renewed only by a new purchase through onboarding. There is
no automatic renewal.

## Recovery

- **Browser closed mid-checkout.** A fresh request resumes from persisted state. No
  second provider order is created.
- **Duplicate or reordered webhooks.** Activation happens once. A resume before payment
  is refused and never issues a code.
- **Crash after the provider order, before the save.** The retry uses the same
  idempotency key.
- **Late payment after cancellation.** The cancelled continuation is not reactivated.
- **Stalled owner.** A lease takeover prevents an old owner from overwriting the new
  owner's binding.
- **Provider or AWS failure.** The user sees a retryable error with a correlation
  reference. Internally the outcome may be uncertain; the next request reconciles
  persisted state before repeating work.

## REST cutover

The REST API is a new target; the HTTP API identity is not reused.

1. Create the REST API and its stage. Each host's MCP connection points at the
   stage-prefixed resource URL, for example `https://<rest-api-id>.execute-api.<region>.amazonaws.com/<stage>/mcp`.
2. Verify discovery and the protected routes with `scripts/verify_access.ts` (below)
   before changing any client configuration.
3. Change each client's MCP resource and connection. Existing grants keep their
   original audience. They are not silently rewritten.
4. Keep the legacy HTTP endpoint only if it enforces the same paid gate. Otherwise
   disable it under a separately scoped cutover action. It must never stay an
   unguarded bypass of the paid service.

Rollback restores the legacy endpoint with its security restored and the client
configuration backed up. It never deletes or resets identities automatically.

## Read-only verification

`scripts/verify_access.ts` checks a deployed endpoint with GET requests only. It never
follows redirects, never sends a real token, and reports fixed messages without
response bodies.

```bash
node dist/scripts/verify_access.js https://<rest-api-id>.execute-api.<region>.amazonaws.com/<stage> <issuer> <resource>
```

It checks the protected-resource and authorization-server metadata, JWKS (public
material only), the 401 challenge on `/mcp` and `/health`, an invalid bearer rejection,
and the anonymous billing redirect. Subscriber, OAuth code, refresh, metering,
recovery and release-identity checks are reported as `not_run`. The verifier does not
assert hard quotas. Its exit code is 1 when a check fails, and 2 for a usage error.

Tests in `tests/access/access_verifier.test.ts` exercise the verifier against fake
deployments, including the failure cases.

## Status of cloud and provider steps

| Step | Status |
|---|---|
| Cognito stack `mcp-access-auth` in `ca-central-1` | Performed (`CREATE_COMPLETE`) |
| Publication stack `mcp-access-publication` | Performed (`UPDATE_COMPLETE`) |
| Access image publication (ECR, immutable, scanned) | Performed earlier, with accepted base-image findings |
| Authorizer ZIP publication | Performed earlier |
| Signing key stack `mcp-access-signing` | Performed (`CREATE_COMPLETE`); key ARN recorded |
| Public JWK in `SigningConfigJson` and `PublicJwksJson` | Derived; not yet deployed to any runtime |
| Storage stack for access tables | Not performed |
| Billing publication stack and image `billing-2026-11-24.4` | Performed (publish run 45482349557) |
| Billing storage, runtime and alias | Not performed; needs approval |
| Access runtime stack | Not performed; needs approval |
| Authorizer stack | Not performed; needs approval |
| REST gateway stack | Not performed; template written and validated locally |
| Cognito callback and logout URLs for real hosts | Not performed (placeholders only) |
| Stripe test-mode payments and webhook | Not performed |
| Live host OAuth, code exchange and REST metering | Not performed |
| Live cutover and rollback | Not performed |

Every "Not performed" item keeps its live evidence as `not_run` in the verification
report until it is performed under an explicit approval.
