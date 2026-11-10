# Quickstart: Planned Access Feature

**Status**: OAuth/session, token, request-driven provisioning and onboarding code are implemented and tested locally. The authorizer ZIP/template are validated locally; the Access image is not built. Gateway integration, full recovery/acceptance matrix, publication and live AWS/provider/host checks remain pending. Current instruction is local-only: do not provision AWS, publish artifacts, register webhooks or charge Stripe.

Read the [endpoint inventory](contracts/endpoints.md), [client onboarding](contracts/client-onboarding.md), [authorization](contracts/authorization.md), [REST gateway](contracts/rest-gateway.md) and [billing onboarding](../003-billing-subscriptions/contracts/checkout-onboarding.md). Implement/validate spec 003's existing storage/catalog/eligibility/internal-operation contracts before dependent access adapters. [Tasks](tasks.md) contain the pending implementation graph.

1. Configure exact host public-client IDs/redirects and Cognito coordinator callback/logout URLs, selected account/region/REST stage, resource/issuer/discovery URLs and native plan limits. Do not reuse the old HTTP API ID as a REST ID or guess client redirects. Confirm path-issuer discovery interoperability before deployment.
2. Bootstrap service publication and billing storage independently; create base REST API only. Use its ID/predictable URLs for identity/access/service/billing deployment; full methods/integrations precede deployment/stage/usage-plan associations. Gateway owns every REST invoke permission and attachment.
3. Continue implementation from the [runtime plan](plan.md); the TypeScript/Express coordinator, token use cases, native Lambda authorizer and request-driven usage binding are already present locally. Run `npm ci` and `npm run check`; the test command typechecks, compiles and runs emitted JavaScript. The authorizer packages as a managed Node.js 24.x ARM64 ZIP; the Access HTTP runtime remains image-based. Local simulations cover core OAuth, payment-to-refresh, subscriber-key provisioning and exact authorizer policies, but not the full adversarial recovery matrix. Missing native prerequisites are unavailable, not pass.
4. Finish gateway/cutover tooling, packaged Access image validation and expanded recovery simulations. Capture separate local Access evidence and service REST transport/report-v2 evidence. Preserve v1 HTTP report compatibility and completed service task markers. No live sign-in/payment/metering/cutover readiness follows from mocks.
5. Future live acceptance requires explicit operator prerequisites and host/test-mode payment setup. Validate 401 discovery, actual Cognito/checkout/code exchange, subscriber-specific plan association and denial-before-service before client cutover. Keep legacy HTTP endpoint secured or disable it through scoped migration; retain rollback and identity data.

Before artifact publication, follow the separate OIDC publisher bootstrap in the
[Access implementation guide](../../docs/access-implementation.md#separate-publication-setup).
The publication template and manual workflows are source-controlled, but they
are not deployed or run; current work remains local-only.

The host obtains a short-lived MCP bearer via code exchange after confirmed activation. It sends no x-api-key. Purchase/renewal uses a bounded enrollment continuation; successful login and billing management enforce [FR-003/FR-004](spec.md#functional-requirements). All provider values for the MCP runtime remain native Lambda environment variables; access/billing secrets never enter that map.

## Node.js onboarding and recovery

Follow the [onboarding contract](contracts/onboarding-workflow.md): status/resume and fresh login perform bounded, idempotent provisioning with persisted leases/retry hints. No access queue/Pipe/DLQ/mapping/schedule is deployed. Billing owns delayed reconciliation and replay; test closed-browser payment recovery separately from request-driven activation. The [delivery contract](contracts/background-delivery.md) defines four functions and billing-only transport.

## Post-implementation renewal reminder

Before live readiness, execute the [expired-subscription/reconnect acceptance checklist](checklists/manual-renewal-acceptance.md) independently for ChatGPT and Claude; verify actual refresh-failure UI and manual renewal, not an assumed automatic redirect.

Begin schema-first development using the shared [implementation-readiness checklist](../003-billing-subscriptions/checklists/implementation-readiness.md); reviewed planning boxes do not mark implementation or live tasks complete.

Use the shared [browser session contract](contracts/browser-sessions.md) for onboarding and direct `/billing` management: same cookie/store/30-minute deadline; reauthenticate through Cognito on expiry, never pass the AI client's MCP token to the browser.
