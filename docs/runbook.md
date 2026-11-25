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
| `/mcp/<env>/access/alias-arn` | `infra/access/runtime.yaml` | Template ready; not deployed |
| `/mcp/<env>/authorizer/alias-arn` | `infra/access/authorizer.yaml` | Template ready; not deployed |
| `/mcp/<env>/access-api/usage-plan-id` | `infra/access/gateway.yaml` | Template ready; not deployed |

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

| Order | Template | Purpose | Key outputs to record |
|---|---|---|---|
| 1 | `infra/access/auth.yaml` | Cognito and identity | User pool and client IDs, issuer |
| 2 | `infra/access/signing.yaml` | KMS RS256 signing key | `SigningKeyArn`, `kid` |
| 3 | Read `SigningKeyArn` from the signing stack output (or `/mcp/<env>/access/signing-key-arn`) | Key ARN (not secret) | Nothing to enter; the runtime derives the public JWK from the ARN |
| 4 | `infra/billing/storage.yaml` | Billing and entitlement tables | `BillingStateName`, `BillingEntitlementsName`, `BillingStreamArn`, `BillingStoragePolicyArn`, `BillingStreamReadPolicyArn` |
| 5 | `infra/observability/template.json` | Log groups, alarms, dashboard | `BillingTelemetryPolicyArn`, `LambdaTracingMode` |
| 6 | Billing runtime (`infra/billing/runtime.yaml`), rendered for your immutable image | Billing Lambda with `live` alias, queue, DLQ | Billing alias ARN, webhook alias ARN |
| 8 | `infra/access/storage.yaml` | Access tables | Table names and ARNs |
| 9 | `infra/access/runtime.yaml` | Access Lambda | Access alias ARN |
| 10 | `infra/access/authorizer.yaml` | Authorizer from the published ZIP | Authorizer alias ARN |
| 11 | `infra/access/gateway.yaml` | REST API, stage, methods | Stage URL |

Notes on the order:

- Deploy `infra/billing/publication.yaml` and publish the billing image before step 7.
  The image must be in ECR with an immutable digest.
- Billing must have its live alias before access can invoke it (step 9).
- For `gateway.yaml`, deploy twice if you enable access logs: the first pass
  without `AccessLogGroupArn`, the second with it (see the access setup guide).

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

## 4. Verify after each stack

- The stack reaches `CREATE_COMPLETE` or `UPDATE_COMPLETE`, and its outputs match the
  table above.
- `cfn-lint` passes on the template (CI runs this on every change).
- After the gateway deploys, run the read-only access verifier against the stage URL:
  `scripts/verify_access.ts`. It sends GET requests only.
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
