# Access implementation and next steps

This increment implements the token-verification/signing/storage foundation of
spec 002. It does **not** finish the browser OAuth/onboarding access Lambda.

The authorizer now targets the managed Node.js 24.x ARM64 runtime. Its release is a
ZIP uploaded as a versioned S3 object; the access HTTP runtime remains image-based.

| Implemented code | Responsibility |
|---|---|
| authorizer/handler.ts | Direct REST REQUEST Lambda; exact ARN, JWT signature/claims/scope and usage-key response |
| security/service-token.ts | Shared closed service-token claims and lifetime/subscription bounds |
| security/jwks.ts | Public-only RSA JWKS validation, bounded fixed-source cache and unknown-kid refresh |
| access/signing.ts | Exact-version Parameter Store loader, parsed private-key cache and local RS256 signing |
| access/store.ts | Strong access/entitlement reads, access-only conditional transactions and profile race recovery |
| infra/access/storage.yaml | Retained on-demand AccessState, selective TTL and exact item-action policy |
| infra/access/authorizer.yaml | Managed-runtime ARM64 ZIP authorizer/version/alias and telemetry-only role; no gateway or public invoke grant |

## Local verification

Run `npm ci` and `npm run check` at the repository root. The authorizer package test
builds an isolated ZIP, checks its contents and checksums, extracts it, then invokes
the actual Lambda handler against a simulated JWKS response. It needs no AWS
credentials or source mount. The packager verifies that the installed `jose`
version matches the authorizer's own manifest and lock, and includes no access,
billing or test modules.

```sh
npm run package:authorizer
```

The ZIP and `.metadata.json` sidecar are written under `.artifacts/`. The sidecar
records source, lockfile, build-config and package SHA-256 values; use its
`packageSha256Base64` value when rendering the immutable Lambda version. This is
local packaging evidence only. No artifact publication, cloud deployment or live
AWS/provider request has run.

## Authorizer configuration for later deployment

Upload the ZIP once to the approved versioned S3 release prefix. Use its exact
bucket, key and S3 object version plus the package hash from the sidecar to render
a retained Lambda version:

```sh
npm run render:authorizer -- \
  'mcp-release-artifacts' \
  'authorizer/test/REPLACE_WITH_PACKAGE_SHA256.zip' \
  'REPLACE_WITH_S3_OBJECT_VERSION' \
  'REPLACE_WITH_BASE64_PACKAGE_SHA256' \
  /tmp/authorizer-release.yaml
cfn-lint /tmp/authorizer-release.yaml
```

The renderer pins the function code to the supplied S3 object version and
`CodeSha256`, and derives a release ID from those immutable artifact inputs. Supply
a new `ReleaseId` whenever runtime configuration changes so CloudFormation
publishes a version with the new settings. Provide the template's FunctionName,
Environment, ArtifactBucket/ArtifactKey/ArtifactVersion, PackageSha256/ReleaseId,
JwksUri, AuthorizerConfig and the **authorizer**
TelemetryPolicyArn from the shared observability stack. The CloudFormation
deployment identity needs read access to that artifact; the Lambda execution role
does not. The function/log-group names and TracingMode must match the telemetry
stack. Do not substitute a storage/signing/billing policy. No Function URL exists.
Gateway-owned invoke permission, REQUEST identity source, TTL 0, AUTHORIZER key
source and paid REST methods are still T007 work, not deployed by this template.

AuthorizerConfig is public configuration; this example contains placeholders:

```json
{
  "issuer": "https://login.example.invalid/test",
  "resource": "https://api.example.invalid/test/mcp",
  "clientIds": ["REGISTERED_PUBLIC_CLIENT_ID"],
  "clockSkewSeconds": 0,
  "region": "us-east-1",
  "accountId": "000000000000",
  "apiId": "actualrestapiid",
  "stage": "test",
  "routes": [
    {"method":"POST","path":"mcp","scope":"mcp:invoke"},
    {"method":"GET","path":"health","scope":"mcp:invoke"}
  ]
}
```

Use actual exact issuer/resource/registration and REST outputs. For a gateway ANY
method, enumerate each allowed real HTTP verb; the authorizer permits no ANY/path
wildcard. Tokens for one API, stage or resource cannot authorize another. Public
OAuth/discovery and Stripe routes must not use this paid authorizer.

JwksUri is a fixed HTTPS URL to an independently published **public** artifact:
`{"keys":[{"kty":"RSA","kid":"YOUR_KEY_ID","alg":"RS256","use":"sig","n":"BASE64URL_MODULUS","e":"AQAB"}]}`.
Up to ten unique opaque key IDs and RSA 2048–8192-bit keys are accepted. No private
RSA fields, octet keys, certificate/key URLs or token-supplied key source is used.
The service-token header is RS256 with kid and typ=at+jwt. Cache age is at most
300 seconds; HTTP fetches abort after three seconds and cap bodies at 32 KiB.
Unknown-key refresh/negative caching is bounded and rate-limited. Publish and
verify new public keys before switching signers, allow for cache propagation,
and retain old public keys for at least 3600+30 seconds after last possible old
issuance, including deployment/cache overlap and rollback.

Invalid credentials produce Unauthorized; a signed token lacking route scope
returns an exact Deny policy. Trusted-key failures remain infrastructure failures,
not evidence that a valid token was correctly rejected. Logs contain sanitized
operation/correlation/native AWS tracking metadata, never bearer/usage keys.

## Signing and state adapters

The access signer accepts only an exact SSM parameter ARN/version and matching
public kid/artifact supplied by deployment configuration. Store the operator's RSA
PKCS8 private key in SecureString through the secure provisioning workflow.
`ssmSigningLoader` requests that exact version with decryption. IAM grants belong
to access alone; narrowly scoped kms:Decrypt is needed only for the selected
SecureString key. There is no KMS Sign API call per token.

Only parsed non-extractable key material is cached, in execution-environment
memory, for at most 300 seconds. Concurrent loads share one three-second attempt.
A cache refresh failure stops signing; it never silently signs with an expired
cache or a mismatched key/version. Public-key publishing must not call this loader.
Signing is **not** proof of paid eligibility: the future token handler validates code/grant, entitlement and configured binding, then commits consumption/rotation with current revision guards before releasing credentials. Do not consume a credential just to load a key; dependency outages must not become replay revocations.

The access state adapter writes only AccessState. BillingEntitlements participates
only in strongly consistent reads and transaction ConditionCheck operations.
Profiles and bindings have no TTL. Codes/refresh/session namespaces and selective
cleanup follow the existing access storage contract. SDK errors retain retry
semantics and are sanitized by the shared telemetry boundaries.

## Next implementation

T015 implements Cognito/browser sessions and the Express OAuth coordinator. T017
implements native subscriber key/usage-plan provisioning. T016 then adds actual
code redemption, refresh rotation, revocation and token responses around the
signing/storage adapters; none of those endpoints is claimed complete here.
Access packaging/gateway/cutover/publication and cross-project/live acceptance
remain unchecked. Billing implementation/setup is documented separately in
[billing setup](billing-setup.md). No new business-policy confirmation is needed.

## Interrupted OAuth work in progress

`access/app.ts`, `config.ts`, `handler.ts`, `identity.ts` and `sessions.ts` now contain an initial Cognito/browser-session coordinator. This work was interrupted before dedicated OAuth/session acceptance tests and packaging were completed. It is not a reviewed T015 completion or deployment-ready flow. Discovery remains fail-closed without composed token/onboarding extensions; code exchange, refresh and provisioning remain pending. The previous 146-test evidence covered the earlier authorizer/signing/state foundation, not these newly drafted HTTP/session paths.

The follow-up implementation pass tightened required configuration fields and type checks, bounded the Cognito token response while streaming at 64 KiB, checks the configured Cognito scopes and nonce digest, rejects a session/config mismatch, and maps malformed or oversized form bodies to client errors. Invalid Cognito authorization responses are excluded from dependency error logs; unexpected provider failures retain sanitized timing/error telemetry. These remain partial T015 hardening changes. The current source typechecks and the local suite passes 146 tests, but those tests do not exercise the new HTTP/session coordinator; it has not been packaged or run through Lambda. T015 and all later access tasks remain open.

HTTP responsibilities are separated into discovery, identity, management and OAuth route modules with shared cookie/error helpers. `handler.ts` remains the composition root. The browser-session workflow depends on storage and identity-provider ports; the concrete DynamoDB and Cognito adapters are assembled only at startup. Typechecking and the existing 146-test suite pass, though dedicated route/session use-case coverage remains part of T015.

Billing workflows now depend on repository, queue, payment-provider and telemetry dependencies rather than concrete AWS or Stripe adapters. Webhook transport validation stays in the handler; verified-event deduplication and reconciliation run in `BillingService`. Shared schema primitives, identity partitioning, canonical JSON and the billing-owned entitlement projection live in `contracts/`, so Access no longer imports Billing implementation modules. Typechecking and all 146 local tests pass. Persistence rows remain an explicit shared storage contract; packaged and live adapter acceptance is still pending.
