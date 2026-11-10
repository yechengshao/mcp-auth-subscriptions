# Billing Lambda setup guide

The executable entrypoint is `billing/handler.ts` (`dist/billing/handler.handler`).
DynamoDB, Parameter Store, Stripe and SQS adapters are real implementations, not
fixture-only ports. AWS clients use the Lambda role. Express preserves raw webhook bytes; the official Stripe SDK uses HTTPS with the
pinned API version `2025-02-24.acacia`; no monitoring SDK or collector is needed.

This guide prepares a **test-mode environment**. It does not claim that the whole
access/billing specification is finished. See the remaining gates at the end.
No AWS deployment, Stripe registration, payment, or image publication was run by
the implementation work. The final Lambda image/ARM64 execution is unverified:
this cloud workspace blocks `public.ecr.aws`; the Node Docker build stage passed.

## 1. Validate locally

Use Node.js 24 and run from the repository root:

```sh
npm ci
npm run check
cfn-lint infra/observability/template.json infra/billing/*.yaml
```

Tests inject simulated service responses into the actual SDK/HTTPS adapters.
They cover conditional transactions, simultaneous purchases, payment retries,
late payment, expiry, signed webhook duplicates, partial SQS batches, upgrade
credit consumption, safe errors and native tracking. They do not contact AWS or
Stripe. Never put production secrets into fixture files or command arguments.

## 2. Prepare AWS and the approved catalog

Choose one account, region, environment and function name. Deploy
`infra/billing/storage.yaml` with IAM capability acknowledgement. Record these
outputs rather than guessing resource names:

| Storage output | Runtime parameter |
|---|---|
| BillingStateName | StateTableName |
| BillingEntitlementsName | EntitlementTableName |
| BillingStreamArn | StateStreamArn |
| BillingStoragePolicyArn | StoragePolicyArn |
| BillingStreamReadPolicyArn | StreamReadPolicyArn |

The two tables are retained, deletion-protected, on-demand, AWS-owned encrypted,
and have point-in-time recovery enabled. PITR costs money. Paid records and
idempotency evidence have no TTL. There is no additional activation table/queue.

Create the nonsecret Parameter Store **String** catalog using the structure in
[the catalog contract](../specs/003-billing-subscriptions/contracts/plan-catalog.md).
Provide actual tier order, duration options, one-time Stripe product/price IDs,
amounts/currencies and preconfigured usage-plan/REST-stage mappings. Account,
region, environment and Stripe account must match this deployment. Increment
catalog_version when content changes. Before enabling Checkout, verify every enabled Stripe price and API Gateway usage-plan/stage mapping exists in the selected environment; schema validation checks shape/scope, not remote resource existence. The backend caches valid catalogs for at
most 60 seconds; it never serves an expired cache after a failed refresh.
Persisted purchases retain their own snapshot. Retrying a pending purchase does
not require reading the newest catalog.

## 3. Prepare Stripe and secret parameters

Use a Stripe test account and approved **one-time** prices. Recurring prices,
subscriptions, automatic renewal, off-session charging and automatic refunds are
not used. Find the actual `acct_...` identifier for StripeAccountId.

Store the test `sk_test_...` key and webhook signing secret as separate Parameter
Store **SecureString** values through your secure administration workflow. Pass
only their names/ARNs into CloudFormation. Both are cached for at most 60 seconds.
The Lambda must be able to retrieve each parameter. If you use a customer-managed
SSM encryption key, supply its exact ARN as SecretKmsKeyArn; otherwise leave it
empty. This is decryption for secret retrieval, not KMS signing per token.

Choose HTTPS success/cancel URLs on the access service. Those pages must verify
the browser session/ownership and query the backend; arriving at a success URL is
not proof of payment. Configure a real support email for refunds, cancellation,
downgrades and ambiguous credit cases.

Stripe account verification occurs before provider calls. Payment verification
checks the owned order, price/product, currency, net amount and successful
PaymentIntent. Term start comes from the provider's `payment_intent.succeeded`
event timestamp, not webhook receipt time. Event lookup is bounded; missing old
or deeply paginated provider evidence returns an error for recovery/support,
never a guessed paid term. Stripe event history is finite, so diagnose retained
repair records promptly. Unknown Checkout POST outcomes reuse the same provider
idempotency key; after 23 hours without saved linkage they require repair rather
than a blind new POST.

## 4. Prepare monitoring before the runtime

Use `infra/observability/template.json` and its README to create the finite log
groups, scoped write policies and economical alarms/dashboard. Its configured
BillingFunctionName must match FunctionName here. Queue and Pipe names are FunctionName + `-reconcile`; the DLQ name is FunctionName + `-reconcile-dlq`, so monitoring can be configured before the runtime without circular stack imports. Supply its
BillingTelemetryPolicyArn output as TelemetryPolicyArn, and its LambdaTracingMode
output as TracingMode. Defaults leave nonproduction X-Ray off; to enable tracing,
set both stacks consistently and validate native sampling in AWS. No
OpenTelemetry/X-Ray SDK, exporter, collector or monitoring function is required.

The runtime emits sanitized JSON failure logs and critical entitlement commits,
propagates available native AWS trace metadata, and restores saved workflow
correlation IDs during reconciliation. It emits the bounded webhook-failure and
due-work-age metrics. No raw webhook payload, address, token, key or cookie is
logged. Use Stripe references through authorized support tools for payment detail.

## 5. Build and publish an immutable ARM64 image

For the AWS publication path, first deploy `infra/billing/publication.yaml`
using the existing GitHub OIDC provider ARN and review the outputs. It creates a
retained, scan-on-push, immutable-tag ECR repository and an OIDC role scoped to
that repository. The role cannot deploy Lambda or access billing data. Do not
create a duplicate account-level OIDC provider.

Configure the GitHub `billing-publish` environment so only `main` can publish and
set required reviewers if desired. Add the stack outputs as repository variables
`BILLING_ECR_REPOSITORY_URI` and `AWS_REGION`; set digest-pinned
`NODE_BUILD_IMAGE` and `LAMBDA_RUNTIME_IMAGE` variables; save the publisher role
ARN in the `BILLING_PUBLISH_ROLE_ARN` secret. Then manually dispatch **Publish
Billing Lambda image** from `main` with a new immutable release tag. The job
runs the tests, builds and pushes once, and saves an artifact with the source
commit, both lockfile hashes, runtime-template hash and ECR image digest. The
workflow is defined but has not been run, and no ECR repository or role has been
created.

For a local ARM64 package build without publishing, run:

```sh
npm run package:billing-image -- \
  --build-image 'node:24-bookworm-slim@sha256:YOUR_APPROVED_DIGEST' \
  --runtime-image 'public.ecr.aws/lambda/nodejs:24@sha256:YOUR_APPROVED_DIGEST' \
  --tag 'billing-local:YOUR_RELEASE_TAG'
```

The local image helper records source/lock/template evidence but cannot produce
an ECR digest. If building inside this managed cloud environment after registry
access is configured, add `--secret id=proxy_ca,src="$CODEX_PROXY_CERT"` so npm
trusts the session proxy. The CA is a build secret mount and is not copied into
the image.

Render the deployment template for that immutable artifact:

```sh
npm run render:billing-runtime -- \
  '000000000000.dkr.ecr.us-east-1.amazonaws.com/billing@sha256:REPLACE_WITH_64_HEX_DIGEST' \
  /tmp/billing-release.yaml
cfn-lint /tmp/billing-release.yaml
```

The renderer creates a new retained Lambda version resource per image and points
the `live` alias to it. Deploy the **rendered** template; reusing the unrendered
Version logical ID would not reliably publish a new version on later releases.
Retaining old versions supports rollback and also requires deliberate cleanup.

## 6. Configure and deploy the disabled test runtime

Supply the parameters declared in `runtime.yaml`: storage/monitoring outputs,
parameter names/ARNs, Stripe account, HTTPS return URLs, support email, image and
release identifier. AccessRoleArn is the exact trusted access coordinator role;
no public Function URL is created. The access role also needs exact-alias
InvokeFunction and projection-read permissions from the access infrastructure
contract. Never expose native billing operations directly as browser JSON APIs.

Start with StripeLive=false and EnableDelivery=false. The template creates one
ARM64 billing Lambda, one work queue, its retained DLQ, one INSERT-only Pipe,
an SQS mapping and scheduled replay, all targeting the same billing function.
There is no activation worker. The shared API Gateway is owned elsewhere.

BudgetsJson is required validated JSON. A complete initial **test** profile is:

```json
{
  "schema_version": 1, "environment": "test",
  "invocation_timeout_seconds": 30, "batch_window_seconds": 5,
  "visibility_timeout_seconds": 185, "sqs_concurrency": 2,
  "reserved_concurrency": 5, "page_size": 25, "max_pages": 4,
  "processing_budget_ms": 10000, "processing_lease_seconds": 60,
  "reconciliation_max_attempts": 288, "dispatch_max_attempts": 3,
  "dispatch_backoff_seconds": 300, "delivery_replay_grace_seconds": 300,
  "replay_interval_seconds": 60, "recovery_horizon_seconds": 86400,
  "history_retention_seconds": 31536000, "initial_delay_seconds": 300,
  "quote_lifetime_seconds": 60, "catalog_cache_seconds": 60,
  "catalog_fetch_timeout_ms": 3000
}
```

Environment must match the deployment. Timeout/window/visibility/concurrency and
replay interval must match the fixed IaC settings; startup rejects drift. A future
change to those settings requires updating both IaC and budgets. Values bound
work, not guarantee payments complete within a deadline. No retention cleanup is
performed automatically. Current replay uses shard 0 with bounded pages and a persisted fenced cursor; monitor backlog and validate fair pagination with real AWS load before scaling beyond this test profile.

Integrate only `POST /billing/webhook` with billing's HTTP handler using API
Gateway Lambda proxy integration. Preserve raw body bytes, isBase64Encoded and
Stripe-Signature; do not JSON-parse/re-serialize the body in a mapping template.
Grant API Gateway InvokeFunction only for that method/route and billing alias.
Use AWS-native REST stage tracing and sanitized access logging from the shared
observability contract; public webhook access does not expose native operations.
Register that HTTPS URL in Stripe test mode with API version `2025-02-24.acacia` for:

- checkout.session.completed
- checkout.session.async_payment_succeeded
- checkout.session.expired

Use the endpoint's corresponding whsec secret parameter. Wrong signatures/mode
return 400; processing failures return 500 for Stripe retry. A secret-store outage
is retryable, not a claim that the payment failed. Recurring events cannot grant
access. The billing return page belongs to access, not this webhook.

## 7. Verify before enabling delivery or live payments

Run these in your test environment and record evidence separately from local tests:

- Invoke listPlans through trusted access; verify only public catalog fields return.
- Complete one Stripe test Checkout; confirm order/subscription/history and the
  entitlement projection commit together and the saved term uses payment time.
- Send duplicate signed events; verify no duplicate term, credit or customer owner.
- Close the browser after payment; confirm the payment persists and fresh login
  can reuse it without another charge once access integration is implemented.
- Enable delivery in the test stack; verify Pipe hints contain numeric generation=1,
  only WORK# generation-1 INSERTs enqueue, and MODIFY/history inserts do not.
- Verify delays, duplicate early messages, partial batches, visibility retries,
  lease recovery, DLQ/redrive and replay overlap. The shared DLQ may contain Pipe
  source-failure envelopes as well as queue messages: diagnose the envelope before
  redrive; do not blindly replay a source record as a canonical queue message.
- Upgrade once; verify credit rounding, reservation and new-term expiry, with old
  access preserved on failure. Test quote expiry, stale source and concurrent tabs.
  Credit from a prior credited/refunded/ambiguous term or changed tier catalog goes
  to support. No app refund endpoint exists.
- Find a sanitized failure and entitlement commit by correlation ID in CloudWatch.
  If tracing is enabled, verify Lambda segments/native gateway linkage in X-Ray.
  Browser redirects and delayed work can have separate traces with shared correlation.
- Test rollback to a retained image/version without deleting either billing table.

Remaining specification gates are tracked in `specs/003-billing-subscriptions/tasks.md`:
live replay checkpoint/pagination behavior at scale, broader fault/redrive
acceptance, deploying and exercising the independent OIDC publication path, access/OAuth/session/usage-key integration
and live ARM64/AWS/Stripe/host acceptance. The access Lambda and JWT authorizer
are not implemented by these billing adapters. Do not treat this as completion of
all specs or enable production charging solely because local fixtures pass. The locally tested dependency versions are pinned in package-lock.json; live compatibility with the selected older Stripe API/webhook version still needs the test-mode checks above.
