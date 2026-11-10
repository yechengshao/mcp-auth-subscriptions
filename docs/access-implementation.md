# Access implementation and next steps

This implementation increment now includes the local OAuth/session coordinator,
token exchange and refresh use cases, request-driven subscriber provisioning,
browser onboarding, and paid subscription management with quote-gated upgrades.
Cloud deployment, native integration acceptance, the REST gateway/cutover and
durable recovery acceptance remain unfinished.

The authorizer now targets the managed Node.js 24.x ARM64 runtime. Its release is a
ZIP uploaded as a versioned S3 object; the access HTTP runtime remains image-based.

| Implemented code | Responsibility |
|---|---|
| authorizer/handler.ts | Direct REST REQUEST Lambda; exact ARN, JWT signature/claims/scope and usage-key response |
| security/service-token.ts | Shared closed service-token claims and lifetime/subscription bounds |
| security/jwks.ts | Public-only RSA JWKS validation, bounded fixed-source cache and unknown-kid refresh |
| access/signing.ts | Exact-version Parameter Store loader, parsed private-key cache and local RS256 signing |
| access/store.ts | Strong access/entitlement reads, access-only conditional transactions and profile race recovery |
| access/usage_bindings.ts | Port-driven subscriber key provisioning, plan association/migration, revision checks and uncertain-effect recovery |
| access/adapters/api-gateway.ts | Native API Gateway SDK adapter with one-attempt mutations and exact read-back only for recovery/conflict cases |
| access/provisioning.ts | Validated composition root for provisioner, deployed REST target and bounded SDK/work budgets |
| access/tokens.ts and access/grants.ts | One-use code exchange, paid-bound signed tokens, rotating refresh families and revocation |
| access/onboarding.ts | Idempotent plan/checkout continuation, payment status, activation and original callback resume |
| access/management.ts | Owner-scoped subscription management, server-priced upgrade quotes, upgrade confirmation, support-only financial requests and post-payment binding activation |
| access/http/ | Thin Express inbound adapters for OAuth, session, onboarding and billing browser routes |
| access/handler.ts | Lambda composition root wiring DynamoDB, Cognito, SSM signing, billing alias and API Gateway ports |
| infra/access/auth.yaml | Retained Cognito create-mode pool, admin-only enrollment, public code-flow client and fixed callbacks |
| infra/access/storage.yaml | Retained on-demand AccessState, selective TTL and exact item-action policy |
| infra/access/authorizer.yaml | Managed-runtime ARM64 ZIP authorizer/version/alias and telemetry-only role; no gateway or public invoke grant |
| infra/access/runtime.yaml | Access container Lambda, scoped dependency IAM, X-Ray configuration and retained version/alias |

The browser management routes use the same verified Cognito session and CSRF
mechanism as onboarding. Upgrade amounts come from Billing's immutable quote; the
browser can only confirm the returned quote ID. The entitlement projection carries
the stable application `subscription_id`, so Access can make an owner-scoped Billing
call without reading payment records. After verified payment, a bounded management
status request reuses the subscriber key and applies the current usage plan; a closed
page can resume on a later management login. Downgrade, cancellation, refund and
ambiguous-credit cases only display the configured support contact.

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

## Separate publication setup

`infra/access/publication.yaml` prepares two independent publisher identities:
one can push immutable, scan-on-push Access images to its retained ECR repository;
the other can add authorizer ZIPs only under the versioned S3 prefix
`access/authorizer/*`. Neither publisher can deploy Lambda, change a gateway,
read/write application data, publish Billing artifacts, or alter the other
component's artifacts. The template reuses the account's existing GitHub OIDC
provider and does not create a duplicate provider.

Before running either workflow, an operator must deploy that publication template
and create the GitHub `access-publish` and `authorizer-publish` environments. In
GitHub, restrict both environments to `main` and configure required reviewers if
desired. Set these environment variables from the template outputs and approved
immutable build configuration:

| GitHub environment | Variables | Environment secret |
|---|---|---|
| `access-publish` | `ACCESS_ECR_REPOSITORY_URI`, `AWS_REGION`, `NODE_BUILD_IMAGE`, `LAMBDA_RUNTIME_IMAGE` | `ACCESS_PUBLISH_ROLE_ARN` |
| `authorizer-publish` | `AUTHORIZER_ARTIFACT_BUCKET`, `AWS_REGION` | `AUTHORIZER_PUBLISH_ROLE_ARN` |

Manually dispatch **Publish Access Lambda image** or **Publish native authorizer
ZIP** from `main` with a new release label. Each workflow runs the required
checks and produces evidence with its source commit and immutable digest or S3
object version. A ZIP upload uses a unique workflow-attempt key and the version ID
returned by S3, so the Lambda renderer can pin the precise object. These workflows
are prepared but have not been run. They do not deploy an Access Lambda, activate
an authorizer version, or change API Gateway.

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

`infra/access/auth.yaml` is create-mode only. If a pool already exists, do not
deploy a replacement or modify the pool to make it fit. Capture only the needed
fields with read-only Cognito commands:

```sh
aws cognito-idp describe-user-pool --user-pool-id 'REPLACE_WITH_POOL_ID' \
  --query 'UserPool.{UserPoolId:UserPoolId,AdminCreateUserConfig:AdminCreateUserConfig}'
aws cognito-idp describe-user-pool-client --user-pool-id 'REPLACE_WITH_POOL_ID' \
  --client-id 'REPLACE_WITH_CLIENT_ID' \
  --query 'UserPoolClient.{UserPoolId:UserPoolId,ClientId:ClientId,GenerateSecret:GenerateSecret,AllowedOAuthFlowsUserPoolClient:AllowedOAuthFlowsUserPoolClient,AllowedOAuthFlows:AllowedOAuthFlows,AllowedOAuthScopes:AllowedOAuthScopes,SupportedIdentityProviders:SupportedIdentityProviders,CallbackURLs:CallbackURLs,LogoutURLs:LogoutURLs,PreventUserExistenceErrors:PreventUserExistenceErrors,EnableTokenRevocation:EnableTokenRevocation}'
aws cognito-idp describe-user-pool-domain --domain 'REPLACE_WITH_DOMAIN_PREFIX' \
  --query 'DomainDescription.{Domain:Domain,UserPoolId:UserPoolId,Status:Status}'
```

Arrange those three returned objects under the `expected`/`observed` fields
accepted by `infra/access/cognito-compatibility.ts`, then run
`npm run check:cognito-snapshot -- /path/to/cognito-describe-snapshot.json`.
The checker compares exact callback/logout URLs, public no-secret client settings,
code-only flow, scopes, hosted-login domain and admin-only enrollment. It prints
only stable mismatch codes and never echoes provider data. It makes no AWS calls;
reuse the pool only if every check passes. The template does not modify or reuse
an existing pool.

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
Signing is **not** proof of paid eligibility: `AccessTokens` validates code/grant,
entitlement and configured binding, then commits consumption/rotation with current
revision guards before releasing credentials. Do not consume a credential just to
load a key; dependency outages must not become replay revocations.

The access state adapter writes only AccessState. BillingEntitlements participates
only in strongly consistent reads and transaction ConditionCheck operations.
Profiles and bindings have no TTL. Codes/refresh/session namespaces and selective
cleanup follow the existing access storage contract. SDK errors retain retry
semantics and are sanitized by the shared telemetry boundaries.

Both runtimes use DynamoDB transactions. IAM authorization is scoped by the
item-level actions on each participating table; there is no separate
`dynamodb:TransactWriteItems` IAM action. Access has only GetItem and
ConditionCheckItem on the entitlement projection, with no PutItem or UpdateItem
permission there. Billing owns the entitlement write and transaction that commits
it with billing state.

## Access provisioning increment

The provisioning use case now stores a stable random candidate key in the subscriber binding before calling API Gateway, creates or reuses the native key, and associates it with the purchased usage plan. Renewals with the same mapping update the entitlement snapshot without another AWS mutation; tier upgrades reuse the same key and move its usage-plan association after checking the current entitlement. Successful mutation responses are persisted with a conditional check against the billing-owned entitlement revision. Routine successful setup does not issue a read-back probe.

Transient definite failures preserve the candidate and provide bounded retry state. An unknown CreateApiKey response is reconciled by the exact deterministic key name and persisted value. An uncertain result that cannot be resolved is held in `repair_required`; the code does not blindly create a second key or repeat a possibly live association mutation. API Gateway client retries are disabled, reads/page counts are bounded, and failures are sanitized through the native CloudWatch/X-Ray dependency boundary. Local fixtures exercise key reuse, upgrade movement, entitlement revision changes and uncertain create/remove/association outcomes.

The onboarding status and resume use cases call this provisioner after checking
current billing-owned eligibility. The Lambda composition and least-privilege IAM
policy are now present. The API-key value is returned only to token issuance and is
never rendered to the browser or written to logs. Native AWS mutations remain
idempotent and recover uncertain outcomes; local tests do not prove propagation or
live AWS behavior. Container build, deployment and live API Gateway acceptance are
still pending.

## OAuth and onboarding implementation

The runtime composes discovery metadata, Cognito login/callback, shared browser
sessions, token/revocation handlers and onboarding controllers through the
`OAuthExtension`. HTTP modules remain thin adapters over session, token and
onboarding use cases; DynamoDB, Cognito, SSM, billing Lambda and API Gateway are
outbound adapters selected at startup. The status poll is a same-origin,
CSRF-protected `POST`; the browser return never trusts Stripe query parameters and
uses a top-level resume `POST` before the 303 to the registered AI callback.

The tests cover registered-client/PKCE validation, callback state binding,
session rotation, cancellation, CSRF, metadata readiness, idempotent Checkout
recovery, payment-pending and activation-ready transitions, original-state callback
issuance, one-use code exchange, refresh rotation/replay revocation, provisioning
retries and a simulated payment-to-refresh journey. The Cognito HTTP exchange,
Stripe events, DynamoDB conditional transactions and API Gateway mutations are
simulated locally; no end-to-end live provider or host behavior is established.

The container definition and Lambda runtime template are present. A local Docker
daemon is unavailable in this environment, so the ARM64 image has not been built or
smoke-tested here. The authorizer ZIP package test is local and separate. No
artifact has been published, no AWS resource has been deployed, and live client,
host, webhook, usage-plan and X-Ray delivery checks remain pending. Billing
implementation/setup is documented separately in [billing setup](billing-setup.md).

## Read-only REST cutover preparation

`scripts/prepare_gateway_cutover.ts` validates a manually collected manifest of the
legacy HTTP endpoint, target REST deployment, exact version-alias integrations and
rollback prerequisites. It emits a review artifact marked as unexecuted and does
not query AWS, modify either gateway, publish artifacts or change client settings.
The old endpoint must remain secured and retained, and a rollback plan plus client
configuration backup digest are required.

```sh
npm run prepare:gateway-cutover -- /path/to/reviewed-cutover-input.json
```

Use current independently verified cloud values as input; the validator cannot
prove that a manually supplied manifest matches AWS. It rejects duplicate or
catch-all routes, wrong-owner aliases and an unprotected MCP/health integration.
The actual REST gateway template and live cutover remain separate unfinished work.

To build the Access image later, supply immutable Node.js 24 build/runtime image
references with their approved SHA-256 digests. The script targets ARM64, requires
both image references to be digest-pinned, and writes local source/lock/template
hash evidence under `.artifacts/`; it does not push to ECR or deploy:

```sh
npm run package:access-image -- \
  --build-image 'node:24-bookworm-slim@sha256:REPLACE_WITH_64_HEX_DIGEST' \
  --runtime-image 'public.ecr.aws/lambda/nodejs:24@sha256:REPLACE_WITH_64_HEX_DIGEST' \
  --tag 'access-local:REPLACE_WITH_RELEASE'
```

After a separately authorized publish, use the ECR repository URI **with its
registry digest** as `ImageUri` for `infra/access/runtime.yaml`. The local Docker
image ID in the evidence file is not an ECR digest.

Billing workflows now depend on repository, queue, payment-provider and telemetry dependencies rather than concrete AWS or Stripe adapters. Webhook transport validation stays in the handler; verified-event deduplication and reconciliation run in `BillingService`. Shared schema primitives, identity partitioning, canonical JSON and the billing-owned entitlement projection live in `contracts/`, so Access no longer imports Billing implementation modules. Persistence rows remain an explicit shared storage contract; packaged and live adapter acceptance is still pending.
