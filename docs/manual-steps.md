# Manual steps (done by a person, not by Claude)

These steps need a person in a console or with credentials that must not pass through chat.
Update the status column as each one is finished. Nothing here has been run by Claude unless marked done.

| # | Step | Where | Output to send back | Status |
|---|---|---|---|---|
| 1 | Create a Stripe test-mode account | Stripe Dashboard | None | Pending |
| 2 | Create one product per plan, with one-time prices per duration (no recurring prices) | Stripe Dashboard, test mode, Product catalog | Price IDs (`price_...`), plan and duration names, amounts, currency | Pending |
| 3 | Copy the test secret key (`sk_test_`) and store it as a SecureString at `STRIPE_KEY_PARAMETER` | AWS console or CLI, on your machine | Parameter name only | Pending |
| 4 | Deploy `infra/billing/catalog.yaml` with the approved catalog JSON as the `CatalogJson` parameter | CloudFormation (after approval) | Stack name | Pending |
| 5 | Deploy the billing storage and runtime stacks, record their outputs | CloudFormation (after approval) | Stack outputs, with ARNs | Pending |
| 6 | Create the Stripe webhook endpoint at `<deployed API URL>/billing/webhook` with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired` | Stripe Dashboard, after step 5 | None | Pending |
| 7 | Copy the endpoint signing secret (`whsec_`) and store it as a SecureString at `STRIPE_WEBHOOK_SECRET_PARAMETER` | AWS console or CLI, on your machine | Parameter name only | Pending |
| 8 | Create the usage plans and REST stage mappings listed in the catalog | API Gateway, after approval | Usage plan IDs, stage names | Pending |
| 9 | Re-authenticate the AWS connection (or provide CLI access) so Claude can read stack outputs and run checks | Claude Code / AWS connector | None | Pending |
| 10 | Give explicit approval for each live action: Stripe test-mode calls and each stack deploy | Chat | Approval message | Pending |
| 11 | Google OAuth client and Cognito setup for sign-in | Google Cloud console, AWS | Confirmed client ID (no secret) | Done for the Cognito stack `mcp-access-auth` (CREATE_COMPLETE, per `authentication-api-access.md`); callback and logout URLs for real hosts still pending |
| 12 | GitHub `billing-publish` environment variables and `BILLING_PUBLISH_ROLE_ARN` secret | GitHub repository settings | None | Done per earlier publish runs |

## Rules for these steps

- Never paste secret keys, webhook secrets, or passwords into chat. Send only parameter names.
- Price IDs, product names, stack names and ARNs are safe to send.
- Live Stripe calls and AWS deploys run only after the approval in step 10.
