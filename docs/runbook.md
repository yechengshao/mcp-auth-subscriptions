# Deployment runbook: access and billing

Use this runbook to deploy the access and billing stacks into a new AWS account, or
to repeat a deployment. It covers the manual steps (see [manual steps](manual-steps.md))
and the order the stacks must be deployed in. It contains no secrets and no
account-specific values: fill those in from your own account.

## 0. Rules

- Every AWS resource is created from a template in `infra/`. Do not create resources
  by hand, except SecureString parameters, which CloudFormation cannot create.
- Deploy inputs come from the approved path (the publication workflows and their
  repository variables). Local shells are for inspection and for the commands below
  when the approved path is not available, with explicit approval.
- Never paste secret keys, webhook secrets or passwords into chat or into command
  arguments. Pass only parameter names or ARNs.
- Every live action needs explicit approval. Record each approval, the stack name and
  the outputs in your deployment log.

## 0a. Parameter naming

Stacks that produce a value other stacks need publish it as an SSM String parameter
named `/mcp/<environment>/<component>/<name>`, for example `/mcp/test/billing/alias-arn`.
Consumers read the parameter by name instead of receiving the value at deploy time.
Parameters are created by the same template that owns the resource, so they change
with it. Only non-secret values belong here; secrets stay in SecureString parameters.
This is the Service Decoupling principle in the project constitution (section
"Service Decoupling", version 1.7.0).

Published parameters (`<env>` is `test` for now):

| Parameter | Published by | Deployed state |
|---|---|---|
| `/mcp/<env>/billing/alias-arn` | `infra/billing/runtime.yaml` | Live (`mcp-billing-test`) |
| `/mcp/<env>/billing/state-table-name` | `infra/billing/storage.yaml` | Live (`mcp-billing-storage`) |
| `/mcp/<env>/billing/entitlements-table-name` | `infra/billing/storage.yaml` | Live (`mcp-billing-storage`) |
| `/mcp/<env>/billing/state-stream-arn` | `infra/billing/storage.yaml` | Live (`mcp-billing-storage`) |
| `/mcp/<env>/access/alias-arn` | `infra/access/runtime.yaml` | Deployed 2026-11-26 (`mcp-access-runtime-test`) |
| `/mcp/<env>/authorizer/alias-arn` | `infra/access/authorizer.yaml` | Deployed 2026-11-26 (`mcp-authorizer-test`) |
| `/mcp/<env>/access-api/usage-plan-id` | `infra/access/gateway.yaml` | Deployed 2026-11-26 (`mcp-access-gateway-test`) |

| `/mcp/<env>/access/state-table-name` | `infra/access/storage.yaml` | Live (`mcp-access-storage`) |
| `/mcp/<env>/access/signing-key-arn` | `infra/access/signing.yaml` | Live (`mcp-access-signing`) |
| `/mcp/<env>/alarms/topic-arn` | `infra/observability/alarm-topic.yaml` | Live (`mcp-alarms-test`) |

Not yet published: alarm topic and observability policy ARNs.

## 1. Inputs to collect

Replace these values per account. Nothing here is copied from this project.

| Input | Where it comes from | Used by |
|---|---|---|
| AWS account ID and region | Your account | All stacks, ARNs |
| Environment name (`test` or `production`) | You choose | Every stack |
| GitHub OIDC provider ARN | Existing account provider (do not create a second one) | `infra/billing/publication.yaml`, `infra/access/publication.yaml` |
| GitHub subject prefix `repo:<owner>@<id>/<repo>@<id>` | Your repo owner and repo IDs | Both publication stacks |
| Artifact bucket name for the authorizer ZIP | You create it | `infra/access/authorizer.yaml` |
| Google OAuth client ID and client secret | Google Cloud console | `infra/access/auth.yaml` (secret is NoEcho) |
| Callback and logout URLs for your real hosts | Your domain | `infra/access/auth.yaml` |
| Stripe account ID (`acct_...`) | Stripe Dashboard | Billing runtime |
| Stripe products and prices with their metadata (`plan_id`, `duration_option_id`, `usage_plan_id`, `rest_api_id`, `stage`, `term_*`, `environment`) | Stripe Dashboard, test mode first | Stripe is the plan and price authority; see the plan-catalog contract |
| Support email | You choose | Billing runtime |
| HTTPS success and cancel URLs | Your access service | Billing runtime |
| Stripe secret key parameter name | You create it (SecureString) | Billing runtime |
| Stripe webhook secret parameter name | You create it after the webhook endpoint exists (SecureString) | Billing runtime |

## 2. Manual steps before deploying

Complete the steps in [manual steps](manual-steps.md) that apply to your account, in
this order:

1. Create the Stripe test account and the one-time prices. Record the price IDs.
2. Store the Stripe secret key as a SecureString. Record the parameter name only.
3. Confirm the GitHub `billing-publish` environment and its variables (see
   [billing setup](billing-setup.md), section 5).

## 3. Deploy order

Deploy in this order. Each stack's outputs feed the next stack's parameters. Record
every output, including ARNs.

Deploy in this order. Each stack's outputs feed the next stack through SSM, so a stack
only needs to exist before the stacks that read its values. Record every output.

| Order | Stack and template | Purpose | Publishes to SSM (`/mcp/<env>/...`) |
|---|---|---|---|
| 1 | `mcp-access-auth`, `infra/access/auth.yaml` | Cognito pool, PKCE client, Google IdP | `access/cognito-issuer`, `cognito-client-id`, `cognito-domain`, `cognito-callback-uri` |
| 2 | `mcp-access-signing`, `infra/access/signing.yaml` | KMS RS256 signing key | `access/signing-key-arn` |
| 3 | `mcp-access-storage` (`infra/access/storage.yaml`) and `mcp-billing-storage` (`infra/billing/storage.yaml`) | Access and billing tables, stream | `access/state-table-name` and billing table names |
| 4 | `mcp-observability-test` (`infra/observability/template.json`), first pass with the placeholder REST API ID; second pass after step 11 | Log groups, telemetry policies, X-Ray rule | Telemetry policy ARNs (stack outputs), read by steps 7, 9 and 10 |
| 5 | `mcp-access-publication` (`infra/access/publication.yaml`) | GitHub OIDC publish roles, ECR repo, release bucket | `access/image-uri` (placeholder), role permissions for the publish workflows |
| 6 | Publish workflows, run from `main` with an approved environment | Access image and authorizer ZIP | `access/image-uri`; `authorizer/artifact-bucket`, `-key`, `-version`, `-sha256` |
| 7 | `mcp-billing-test` (`infra/billing/runtime.yaml`) | Billing Lambda with `live` alias, queue, DLQ | `billing/alias-arn` |
| 8 | `mcp-access-public-urls-test` (`infra/access/public-urls.yaml`) | Issuer, resource and metadata URLs | `access/issuer-url`, `access/resource-url`, `access/resource-metadata-url` |
| 9 | `mcp-access-runtime-test` (`infra/access/runtime.yaml`) | Access Lambda with `live` alias | `access/alias-arn` |
| 10 | `mcp-authorizer-test` (`infra/access/authorizer.yaml`) | Authorizer Lambda from the published ZIP | `authorizer/alias-arn` |
| 11 | `mcp-access-gateway-test` (`infra/access/gateway.yaml`) | REST API, stage, methods, logging role | `access-api/rest-api-id`, `access-api/stage`, `access-api/usage-plan-id` |
| 12 | `mcp-access-domain-test` (`infra/access/domain.yaml`) | Certificate, regional custom domain, Route 53 alias | Nothing; reads the REST API ID and stage |

Notes on the order:

- Steps 1 to 3 can run in any order. Step 4 must run before steps 7, 9 and 10, because each
  runtime takes its telemetry policy ARN from the observability stack and attaches it to its
  execution role. Step 8 must run before step 11, because the gateway reads
  `access/resource-metadata-url` when it deploys.
- Step 5 must run before step 6, because the publish role may write only the parameters
  `publication.yaml` grants it. The publish workflows run only from `main` and need an
  approval on their GitHub environment (`access-publish`, `authorizer-publish`).
- Step 7 (billing alias) must exist before the access runtime invokes it (step 9).
- Step 4 deploys with the placeholder REST API ID. After step 11, update the observability
  stack so it uses the real ID from `access-api/rest-api-id`. Its execution log group is
  named by that ID, and an empty log group created by API Gateway must be removed first so
  the stack can create it with retention.
- Step 12 is last. The domain only maps the hostname to the gateway's stage.
- The gateway creates its own access log group, `/aws/apigateway/mcp-access-<stage>/access`,
  and the account-level CloudWatch logging role. No extra stack or second pass is needed.

Example deploy command for one stack. Run it only through the approved path, or with
explicit approval, and substitute your own stack name and parameter values:

```sh
aws cloudformation deploy \
  --region <region> \
  --stack-name <stack-name> \
  --template-file <template-path> \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides Environment=<environment> <Key>=<Value>
```

## 2a. Public issuer, resource and metadata URLs

`infra/access/public-urls.yaml` (stack `mcp-access-public-urls-test`) publishes three values:

- `/mcp/<env>/access/issuer-url`: `https://access.tradingview.chat`
- `/mcp/<env>/access/resource-url`: `https://access.tradingview.chat/mcp`
- `/mcp/<env>/access/resource-metadata-url`: `https://access.tradingview.chat/.well-known/oauth-protected-resource`

The access runtime refuses to start on an `UNSET` or non-HTTPS value. The gateway reads the
metadata URL at deploy time and bakes it into the 401 `WWW-Authenticate` header, so a change
to that URL needs a gateway redeploy. The issuer has no path, so the gateway has no
issuer-path discovery routes. These values are defaults in the template, not deploy inputs.

## 3a. Stripe plans and prices (manual, per environment)

Stripe is the authority for plans, durations and the usage-plan mapping. Nothing here is generated by a script; a person creates the objects in the Stripe Dashboard for the environment's account and mode, and records them below. Test mode first. Production uses the live account and is repeated only after the test path is verified and approved.

Prerequisites:
- The gateway stack is deployed and each usage plan ID has been read from its SSM parameter (`/mcp/<env>/access-api/...`) or the gateway stack outputs. Copy the exact ID; do not retype it from memory.
- The `rest_api_id` and `stage` match the deployed gateway (`/mcp/<env>/access-api/rest-api-id` and the stage input).
- The Stripe account ID (`acct_...`) matches `STRIPE_ACCOUNT_ID`, and the mode matches `STRIPE_LIVE` (test keys for test, live keys for production).

Procedure, per billing plan:

1. **Create the product.** Name it for the plan. Add product metadata:
   - `plan_id`: the stable plan identifier, for example `basic` (letters, digits, `_` or `-`, at most 128 characters)
   - `tier_order`: a unique integer across plans in this environment (`1` is the lowest tier)
   - `enabled_for_purchase`: `false` until verified, then `true`
   - `actions`: comma list of `purchase`, `renewal`, `upgrade`, for example `purchase,renewal`
   - `environment`: `test` or `production`, matching the deployment
   Set the description to the customer-facing text. Do not add recurring prices.
2. **Create one one-time price per duration option** on that product. Use mode `payment` (one-time, no recurring). Set the amount in minor units and the currency in lowercase three-letter code (for example `1000` and `cad` for 10.00 CAD). Add price metadata:
   - `plan_id`: must equal the product's `plan_id`
   - `duration_option_id`: stable and unique within the plan, for example `m1` or `m12`
   - `term_unit`: `day`, `month` or `year`
   - `term_count`: the number of units, within the limits of the service-term contract (day 1–3650, month 1–120, year 1–10)
   - `term_semantics`: `utc_fixed_days` for day, `utc_calendar_clamp` for month and year
   - `label`: the customer-facing label, at most 200 characters
   - `usage_plan_id`: the usage plan ID for this plan (from step above)
   - `rest_api_id`: the deployed REST API ID
   - `stage`: the deployed stage name
   - `enabled_for_purchase`: `false` until verified, then `true`
   - `environment`: the same value as the product
3. **Keep all durations of one plan on the same usage mapping.** Every price of a plan must carry the same `usage_plan_id`, `rest_api_id` and `stage`. A plan whose prices disagree is removed from the listing.
4. **Do not reuse a `duration_option_id` within one plan.** Two prices with the same ID cancel each other out.
5. **Do not create objects in the other mode or environment.** A test-mode object is never listed in production, and the reverse.
6. **Run the read-only verifier.** With the Stripe secret key in the environment (never in chat), run `npm run verify:stripe-catalog -- <environment> <aws_account_id> <region> <stripe_account> <live> <rest_api_id> <stage>`. It prints counts and one line per excluded object with a reason code, and exits non-zero if anything is excluded or nothing is sellable. It makes only GET requests.
7. **Verify on the plan page.** Load the billing plan page for this environment and check: each plan appears with the right name, description and tier; each duration shows the right label, amount, currency and term; no plan is missing. The page never shows usage-plan IDs, REST API IDs or stages, so check those in the Stripe Dashboard metadata.
8. **Enable.** Set `enabled_for_purchase` to `true` on the product and its prices only after step 6 passes. Re-check the page after enabling.

Rules after publication:
- Never edit the metadata of a price that has been used for a quote or purchase. To change a mapping, create a new price with the new metadata, set the old price to inactive, and leave it in place for existing orders.
- Deactivate a plan by setting its `enabled_for_purchase` to `false`. Existing subscriptions keep their snapshot.
- The billing runtime reads the REST API ID and the stage from `/mcp/<env>/access-api/rest-api-id` and `/mcp/<env>/access-api/stage`, which the gateway stack publishes. No stage input is needed.
- Keep a record of each price ID, its plan and duration, and the approval, in the manual-steps table.

## 4. Verify after each stack

- The stack reaches `CREATE_COMPLETE` or `UPDATE_COMPLETE`, and its outputs match the
  table above.
- `cfn-lint` passes on the template (CI runs this on every change).
- After the gateway deploys, run the read-only access verifier. It sends GET requests only.
  Pass the execute-api stage URL as the base, and the public issuer and resource URLs:
  `node dist/scripts/verify_access.js https://<rest-api-id>.execute-api.ca-central-1.amazonaws.com/<stage> https://access.tradingview.chat https://access.tradingview.chat/mcp`
  The metadata and login checks use the public issuer host. The checks that need paid
  subscribers or a browser login report `not_run`.
- Run `npm run verify:billing` locally. It reports the current test counts and which
  evidence tests pass; live checks stay `not_run` until they are performed.

## 5. Stripe webhook, after step 11

1. In Stripe test mode, create a webhook endpoint at `<stage URL>/webhooks/stripe`.
2. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`
   and `checkout.session.expired`.
3. Store the signing secret as a SecureString at the webhook parameter name.
4. Send a test event from the Stripe Dashboard and confirm the response is 200.

## 6. Rollback

- Stacks with retained resources (tables, ECR repository, KMS key, Lambda versions)
  keep their data. Rolling back a stack reverts its configuration, not its stored data.
- Signing key rotation and rollback: see the access setup guide, "Signing and key
  rotation". Keep the old public key published until its tokens expire.
- Billing: keep the previous Lambda version. Point the `live` alias back to it through
  the renderer output, not by editing the alias by hand.
- Stripe: disable the webhook endpoint in the Dashboard to stop deliveries.

## 7. Values to replace for a new account

The repository files contain this project's values in these places. Replace them
before deploying anywhere else:

- `infra/access/publication.params.json` and `infra/billing/publication.params.json`:
  the OIDC provider ARN, the GitHub subject prefix and the artifact bucket name.
- Any ARN or account ID inside `docs/` examples (use your own when following them).
- The Cognito callback and logout URLs in `infra/access/auth.yaml` parameters.
- The Stripe account ID, support email and return URLs.

Do not copy another account's stack outputs, parameter names or secrets. Each account
records its own.

## Related documents

- [Manual steps](manual-steps.md): the list of tasks a person does by hand, with status.
- [Billing setup](billing-setup.md): full billing guide, including budgets and the webhook.
- [Authentication and API access](authentication-api-access.md): access guide, including
  signing key rotation.
