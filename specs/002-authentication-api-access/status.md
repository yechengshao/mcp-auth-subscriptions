# Status and History: Authentication and API Access

This file holds the dated progress, local-implementation evidence and per-task requirement coverage moved out of [tasks.md](tasks.md). Task IDs and checkbox states live only in tasks.md.

## Requirement coverage per task

The original task list recorded these mappings; the spec remains the authority for requirement text.

| Task | Requirements |
|---|---|
| T001 | FR-005, FR-006, FR-007, FR-011, FR-012, FR-016, SC-003, FR-019, FR-021 |
| T002 | FR-002, FR-003, FR-007, FR-008, FR-010, FR-014, FR-016, SC-001, SC-004, SC-007 |
| T003 | FR-002, FR-003, FR-007, FR-008, FR-010, FR-016, SC-001, SC-004, SC-007 |
| T004 | FR-002, FR-007, FR-010, FR-012, SC-005 |
| T005 | FR-001, FR-007, FR-009, FR-011, FR-012, FR-013, FR-014, FR-016, SC-002, SC-004, SC-005, SC-006, FR-019, FR-020, FR-021 |
| T006 | FR-005, FR-006, FR-009, FR-010, FR-011, SC-003 |
| T007 | FR-004, FR-005, FR-006, FR-007, FR-008, FR-011, FR-012, FR-015, FR-016, FR-017, SC-001, SC-002, SC-003, SC-004, SC-007, SC-008 |
| T008 | FR-002, FR-007, FR-010, FR-012, SC-005 |
| T009 | FR-003, FR-005, FR-006, FR-008, FR-010, FR-011, FR-012, FR-013, FR-014, FR-015, FR-016, FR-017, FR-018, SC-001, SC-003, SC-004, SC-005, SC-006, SC-007, SC-008, FR-019, FR-020, FR-021, SC-009, SC-010 |
| T010 | FR-001, FR-004, FR-005, FR-006, FR-009, FR-010, FR-011, FR-012, FR-013, FR-014, FR-015, FR-016, FR-017, FR-018, SC-002, SC-003, SC-005, SC-006, SC-008, FR-019, FR-020, FR-021, SC-009, SC-010 |
| T011 | FR-002, FR-007, FR-010, FR-012, FR-018, SC-005, SC-006, FR-019, FR-020, FR-021, SC-009, SC-010 |
| T012 | FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010, FR-011, FR-012, FR-013, FR-014, FR-015, FR-016, FR-017, FR-018, SC-001, SC-002, SC-003, SC-004, SC-005, SC-006, SC-007, SC-008, FR-019, FR-020, FR-021, SC-009, SC-010 |
| T013 | FR-001, FR-003, FR-004, FR-005, FR-006, FR-008, FR-009, FR-010, FR-011, FR-012, FR-013, FR-014, FR-015, FR-016, FR-017, FR-018, SC-001, SC-002, SC-003, SC-004, SC-005, SC-006, SC-007, SC-008, FR-019, FR-020, FR-021, SC-009, SC-010 |
| T014 | FR-001, FR-004, FR-010, FR-012, FR-013, FR-014, FR-015, FR-018, SC-002, SC-006, SC-008, FR-019, FR-020, FR-021, SC-009, SC-010 |
| T015 | FR-001, FR-004, FR-010, FR-012, FR-013, FR-015, SC-002, SC-006, SC-008 |
| T016 | FR-002, FR-003, FR-008, FR-010, FR-013, FR-014, SC-001, SC-004, SC-006 |
| T017 | FR-003, FR-007, FR-008, FR-010, FR-016, FR-017, SC-001, SC-004, SC-007 |
| T018 | FR-004, FR-010, FR-012, FR-013, FR-014, FR-016, FR-018, SC-002, SC-004, SC-006, SC-007, FR-019, FR-020, FR-021, SC-009, SC-010 |
| T019 | FR-010, FR-012, FR-013, FR-014, FR-016, FR-018, SC-005, SC-006, FR-019, FR-020, FR-021, SC-009, SC-010 |
| T020 | FR-001, FR-002, FR-003, FR-004, FR-008, FR-010, FR-012, FR-013, FR-014, FR-015, FR-016, FR-017, FR-018, SC-001, SC-002, SC-004, SC-005, SC-006, SC-007, SC-008, FR-019, FR-020, FR-021, SC-009, SC-010 |
| T021 | FR-007, FR-010, FR-011, FR-012, SC-005 |
| T022 | FR-004, FR-010, FR-012, FR-013, FR-016, FR-018, FR-019, FR-020, FR-021, SC-002, SC-005, SC-006, SC-009, SC-010 |
| T023 | FR-004, FR-008, FR-010, FR-012, FR-013, FR-016, FR-019, FR-020, FR-021, SC-002, SC-004, SC-006, SC-009, SC-010 |
| T024 | FR-005, FR-007, FR-009, FR-010, FR-011, FR-012, FR-019, FR-020, FR-021, SC-003, SC-005, SC-009, SC-010 |
| T025 | FR-001, FR-003, FR-004, FR-008, FR-010, FR-012, FR-013, FR-014, FR-015, FR-016, FR-018, FR-019, FR-020, FR-021, SC-001, SC-002, SC-004, SC-005, SC-006, SC-008, SC-009, SC-010 |

## Dependency order and status


25 tasks, three fully checked. T014 and T015–T020 have substantial local code, but stay unchecked until their defined contract, dependency, packaging and acceptance criteria are closed. The dependency order remains T001 → T014 → (T002 → T003 → T004; T015; T017; T006; T021; T022) → T016 → T023 → T018 → T019 → T005 → T024 → T007 → (T008; T025) → T020 → T009 → T010 → T011 → T012 → T013. T008 also requires T021. External spec-003 billing acceptance and spec-001 REST runtime/report work remain prerequisites for cross-stack evidence. Real event/schedule recovery and provider/host checks stay not_run.


Monitoring progress: [local telemetry helpers and prepared IaC](../../observability/README.md) cover bounded logs/native AWS tracking, HTTP/native/SQS/replay adapters, correlation propagation, economical profiles and redaction/context/template tests. Access and billing runtime compositions now create bounded telemetry and relay supported AWS request context through dependency adapters. Shared monitoring resources, configured alarm thresholds, deployed sampling and live trace/log acceptance remain pending; no additional task is marked complete by this foundation.

## Local implementation increment (2026-11-10)

T001/T014 have retained access-storage and exact dependency/role boundary tests plus a typed service-token/JWKS/config contract; complete gateway/registration/transition wiring remains open. T002/T003 have the direct REQUEST handler, isolated JWT-only runtime manifest/lock, trusted-key caches and signed denial/privacy/route/scope tests. T004 now produces a reproducible managed-runtime ZIP, records source/lock/config/package hashes, and smoke-tests the extracted Lambda handler. The previous authorizer Dockerfile/container check has been removed. T005's authorizer template and renderer now target Node.js 24.x ARM64, a versioned S3 object and Lambda `CodeSha256`; the broader Cognito/access/gateway infrastructure task remains incomplete.

T016 local implementation: `access/tokens.ts` and `access/http/token-handlers.ts` implement PKCE-bound one-use code exchange, paid-bound JWT issuance with the subscriber usage key, refresh rotation/replay revocation, RFC 7009 and session logout integration. `access/signing.ts` uses exact-version SSM RS256 loading and a bounded memory cache. Tests cover code replay, expiry/authority races, refresh replay, revoked eligibility and sanitized HTTP responses. Runtime tests remain local and cannot establish live SSM/DynamoDB behavior.

T015 local implementation: the Cognito/browser coordinator has feature-specific HTTP routers, shared cookie/error helpers and storage/identity ports, with strict configuration and bounded Cognito response parsing. `tests/access/oauth.test.ts` exercises the API Gateway v1 adapter, registered-client validation, state/browser binding, PKCE exchange inputs, session rotation, cancellation, management eligibility, CSRF logout, composed metadata and correlation/X-Ray context. The Lambda composition now includes the token and onboarding extensions. Packaged-runtime and live Cognito/client checks remain open.

T017 local implementation: `access/usage_bindings.ts` implements port-driven key creation/reuse, current-entitlement revision checks, same-key usage-plan changes and bounded request-driven state; `access/adapters/api-gateway.ts` uses the native SDK with retries disabled and exact-key/association reads only for conflict or recovery. Fixtures cover success/reuse, upgrade, retry after definite failure, uncertain create/add/remove outcomes and revision changes. Onboarding status/resume now invokes provisioning, and `infra/access/runtime.yaml` includes scoped runtime IAM. Concurrent lease stress, container packaging and live AWS acceptance remain open.

T018 local implementation: `access/onboarding.ts` and `access/http/onboarding-handlers.ts` implement persisted plan selection, idempotent Checkout continuation, CSRF-protected status polling, verified payment/activation gating and top-level callback resume. The browser return is presentation-only. `tests/access/client_journey.test.ts` joins payment-pending, current entitlement, binding setup, code exchange and refresh. Durable recovery/race cases covered by T023/T025 and live provider/host behavior remain open.

T022 contract validation increment: transaction transitions distinguish pre-identity Cognito `cancelled` from a verified `failed` phase. `tests/access/onboarding_contract.test.ts` exercises the real AccessStore transaction builder to confirm cancellation atomically consumes the upstream PKCE attempt, revokes the browser session, and writes a schema-valid cancelled transaction. Cross-release compatibility and the full crash/recovery matrix remain open.

T023 recovery-test increment: `tests/access/usage_bindings.test.ts` now holds a native key creation call in flight while a second status request races. The persisted lease allows one mutation, returns a retryable activation result to the second request and reuses the same binding after completion. Broader callback crash, stale-owner and rollback matrices remain open.

T006 local increment: `scripts/prepare_gateway_cutover.ts` and `tests/access/gateway_cutover.test.ts` produce a read-only review artifact for distinct legacy HTTP and target REST APIs, verify the protected REST core routes and exact qualified alias ownership, reject catch-all/duplicate/conflicting routes, and require retained secured legacy plus rollback evidence. It never calls AWS or edits host configuration; Cloud state must still be independently verified.

T005 Cognito reuse increment: `infra/access/cognito-compatibility.ts` and `scripts/check_cognito_compatibility.ts` validate allowlisted read-only Describe* snapshots against the exact public code-flow/admin-enrollment contract without returning user-pool or client data. This checks configuration compatibility locally; it does not call AWS or deploy/reuse a pool.

T021 publication bootstrap increment: `infra/access/publication.yaml` now defines separate environment-bound OIDC roles for the Access ECR repository and versioned authorizer S3 prefix; static tests deny deployment/data access and cross-component publishing. T008's manual main-only workflows package/publish the two artifacts separately and save digest/version evidence. They require the publication stack and protected GitHub environments to be configured by an operator, and neither workflow has been run. Keep T008/T021 unchecked until the bootstrap and required local validation are complete; live publication remains a separate acceptance step.

T015 discovery increment: `access/http/discovery-routes.ts` now serves the standard issuer-path authorization-server and resource-path protected-resource aliases only when their suffix exactly matches configured issuer/resource paths. Stage-prefixed URL results and unknown suffix denial are covered in `tests/access/oauth.test.ts`; clients and deployed domain mappings still require live compatibility verification.

T020 journey increment: `tests/access/client_journey.test.ts` now proves a failed PKCE attempt leaves the one-use code retryable, a verified subscription revocation rejects refresh and revokes its family, and the stateless REQUEST authorizer can still accept an already-issued access token within its signed lifetime. This is bounded-window behavior, not immediate access-token revocation. Full payment callback/recovery races, REST-to-MCP integration and provider/host acceptance remain open.

T019/T020 progress: the ARM64 access Dockerfile and digest-pinned Lambda runtime template exist; the image has not been built because the shared environment cannot connect to its Docker daemon. `client_journey.test.ts` covers one local end-to-end happy/recovery path but not the full T020 adversarial matrix or integrated REST-to-MCP authorization.

T018 management increment: `access/management.ts` and `access/http/management-handlers.ts` implement owner-scoped paid upgrades. The read-only entitlement projection now carries the stable `subscription_id`; Access supplies the current revision to Billing's quote operation, confirms only a Billing-issued quote, persists the own order before redirecting to Stripe, and prepares the existing subscriber key binding after payment is verified. Downgrade/cancel/refund and portal requests display Billing's support email without financial mutation. Tests cover CSRF, quote display, owner/order checks, failed-payment preservation and paid request-driven rebinding. `GET /billing/orders/{orderId}` returns sanitized status only for the order attached to the verified onboarding or management transaction.

See [implementation guide](../../docs/access-implementation.md). Native X-Ray/CloudWatch wrappers and prepared telemetry-only authorizer policy wiring are present; actual delivery remains not_run. No AWS provisioning, provider calls, image publication or notification ran.

Current local verification: TypeScript typecheck/build, all 225 tests, `cfn-lint infra/observability/template.json infra/access/*.yaml infra/billing/*.yaml`, workflow YAML parsing, and `git diff --check` pass. The required CI workflow is now `.github/workflows/test-access.yml` and separately validates the billing/authorizer production locks. The local end-to-end journey signs the issued JWT, verifies it through the REQUEST authorizer and proves a tampered usage key is denied before mock MCP. Authorizer ZIP packaging is exercised locally. Stage-prefixed well-known discovery aliases have exact-path tests. The access ARM64 image has not been built, and no Access Lambda was deployed. Local fakes do not prove Cognito, billing alias, SSM, DynamoDB, API Gateway, ChatGPT/Claude, X-Ray delivery or usage-plan behavior in AWS.

## Cognito: self-registration and Google federation (T005 partial, 2026-11-14)

- Contract (`contracts/authorization.md`) now allows self-registration and exactly one Google federation (OIDC, operator-owned Google OAuth client). Additional providers or flows still need a design change.
- `infra/access/auth.yaml`: `AllowAdminCreateUserOnly: false`; `AWS::Cognito::UserPoolIdentityProvider` for Google (retained) with client ID and `NoEcho` client-secret parameters; app client lists `COGNITO` and `Google` and depends on the provider. Cognito resources keep `DeletionPolicy: Retain`.
- `infra/access/cognito-compatibility.ts` and both tests updated: self-registration required; identity providers must be exactly COGNITO and Google. Results: compatibility tests 2/2, access contract test 8/8, cfn-lint clean.
- Pending: Google Cloud OAuth client (operator step; redirect `https://<domain>.auth.ca-central-1.amazoncognito.com/oauth2/idpresponse`), domain prefix, base REST API ID for callback URLs. T005 stays open for the authorizer and the rest of its scope.
