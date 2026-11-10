# Access implementation and next steps

This increment implements the token-verification/signing/storage foundation of
spec 002. It does **not** finish the browser OAuth/onboarding access Lambda.

| Implemented code | Responsibility |
|---|---|
| authorizer/handler.ts | Direct REST REQUEST Lambda; exact ARN, JWT signature/claims/scope and usage-key response |
| security/service-token.ts | Shared closed service-token claims and lifetime/subscription bounds |
| security/jwks.ts | Public-only RSA JWKS validation, bounded fixed-source cache and unknown-kid refresh |
| access/signing.ts | Exact-version Parameter Store loader, parsed private-key cache and local RS256 signing |
| access/store.ts | Strong access/entitlement reads, access-only conditional transactions and profile race recovery |
| infra/access/storage.yaml | Retained on-demand AccessState, selective TTL and exact item-action policy |
| infra/access/authorizer.yaml | Prepared ARM64 authorizer/version/alias and telemetry-only role; no gateway or public invoke grant |

## Local verification

Run `npm ci` and `npm run check` at the repository root. The JWT library is pinned
in the root development lock and in the independent authorizer runtime lock.
Billing now has its own runtime manifest/lock excluding the signing dependency;
its image still copies only billing/shared observability code.

The isolated packaged check runs without source mounts or AWS credentials:

```sh
docker build --target validation -f authorizer/Dockerfile \
  -t authorizer-local-validation .
```

For this managed environment, add
`--secret id=proxy_ca,src="$CODEX_PROXY_CERT"` for build-time npm CA trust.
The validation image installs only the authorizer's production dependency, generates
ephemeral test keys in memory, and exercises the actual exported Lambda handler
with a simulated fixed JWKS HTTP response. It verifies Allow, tamper rejection,
exact policy scope and absence of datastore dependencies. Its test script is not
copied into the final Lambda image.

This is a host-architecture Node container check. Final Lambda image/ARM64 and live
Gateway/X-Ray behavior remain not_run; public.ecr.aws was blocked in this workspace.
No image publication, cloud deployment or live AWS/provider request was performed.

## Authorizer configuration for later deployment

Use a digest-pinned image built for ARM64 from `authorizer/Dockerfile`; supply
approved immutable BUILD_IMAGE/LAMBDA_IMAGE digests when publishing. Render a
separate retained Lambda version for each final ECR artifact:

```sh
npm run render:authorizer -- \
  '000000000000.dkr.ecr.us-east-1.amazonaws.com/authorizer@sha256:REPLACE_WITH_64_HEX_DIGEST' \
  /tmp/authorizer-release.yaml
cfn-lint /tmp/authorizer-release.yaml
```

Supply the prepared template's FunctionName, Environment, ImageUri/ReleaseId,
JwksUri, AuthorizerConfig and the **authorizer** TelemetryPolicyArn from the shared
observability stack. The function/log-group names and TracingMode must match that
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
