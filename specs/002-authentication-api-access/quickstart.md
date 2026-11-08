# Quickstart: Planned Access Feature

**Status**: Design and task instructions only. No access templates/code/workflows referenced below have been implemented. User requested local testing; do not provision AWS, publish images, register webhooks or charge Stripe as part of this step.

Read the [endpoint inventory](contracts/endpoints.md), [client onboarding](contracts/client-onboarding.md), [authorization](contracts/authorization.md), [REST gateway](contracts/rest-gateway.md) and [billing onboarding](../003-billing-subscriptions/contracts/checkout-onboarding.md). Implement/validate spec 003's existing storage/catalog/eligibility/internal-operation contracts before dependent access adapters. [Tasks](tasks.md) contain the pending implementation graph.

1. Configure exact host public-client IDs/redirects and Cognito coordinator callback/logout URLs, selected account/region/REST stage, resource/issuer/discovery URLs and native plan limits. Do not reuse the old HTTP API ID as a REST ID or guess client redirects. Confirm path-issuer discovery interoperability before deployment.
2. Bootstrap service publication and billing storage independently; create base REST API only. Use its ID/predictable URLs for identity/access/service/billing deployment; full methods/integrations precede deployment/stage/usage-plan associations. Gateway owns every REST invoke permission and attachment.
3. Implement TypeScript/Express access endpoints and direct TypeScript Lambda authorizer/workers using the [runtime plan](plan.md), per-component npm lockfiles, npm ci and required typecheck/build before running emitted tests; run isolated local access tests with generated signing keys and simulated Cognito, Stripe, DynamoDB, Parameter Store and native API-key management. Exercise end-to-end code/S256 exchange, unpaid onboarding, verified payment, pending binding, existing-subscriber reconnect, refresh/replay, plan/expiry and exact method policies. Run packaged ARM64 handlers and lint the target templates. Missing native prerequisites are unavailable, not pass.
4. Capture separate local access evidence and service REST transport/report-v2 evidence. Preserve v1 HTTP report compatibility and completed service task markers. No live sign-in/payment/metering/cutover readiness follows from mocks.
5. Future live acceptance requires explicit operator prerequisites and host/test-mode payment setup. Validate 401 discovery, actual Cognito/checkout/code exchange, subscriber-specific plan association and denial-before-service before client cutover. Keep legacy HTTP endpoint secured or disable it through scoped migration; retain rollback and identity data.

The host obtains a short-lived MCP bearer via code exchange after confirmed activation. It sends no x-api-key. Purchase/renewal uses a bounded enrollment continuation; successful login and billing management enforce [FR-003/FR-004](spec.md#functional-requirements). All provider values for the MCP runtime remain native Lambda environment variables; access/billing secrets never enter that map.

## Node.js onboarding and recovery

Follow the [onboarding contract](contracts/onboarding-workflow.md): status/resume and fresh login perform bounded, idempotent provisioning with persisted leases/retry hints. No access queue/Pipe/DLQ/mapping/schedule is deployed. Billing owns delayed reconciliation and replay; test closed-browser payment recovery separately from request-driven activation. The [delivery contract](contracts/background-delivery.md) defines four functions and billing-only transport.

## Post-implementation renewal reminder

Before live readiness, execute the [expired-subscription/reconnect acceptance checklist](checklists/manual-renewal-acceptance.md) independently for ChatGPT and Claude; verify actual refresh-failure UI and manual renewal, not an assumed automatic redirect.

Begin schema-first development using the shared [implementation-readiness checklist](../003-billing-subscriptions/checklists/implementation-readiness.md); reviewed planning boxes do not mark implementation or live tasks complete.
