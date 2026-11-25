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

## T001 closed (2026-11-14)

Boundary tests now cover cross-stack grants (entitlement table and billing alias only), authorizer isolation, retained state with TTL, Cognito retention and Google federation, the prepared authorizer's invoke surface, and no cross-stack imports (`ImportValue`) in access templates. Circular dependencies inside a template are caught by cfn-lint (E3004, verified on a planted cycle), and all five access templates pass cfn-lint. The service side checks that `runtime-rest.yaml` takes `RestApiId` and no access outputs (`tests/integration/test_deployment_contract.py`). Access contract suite: 9/9.

## T014 entitlement projection (2026-11-18)

- `tests/access/oauth_contract.test.ts` (new, the file T014 names): the billing-owned entitlement projection passes with its stable `subscription_id`, and is rejected when the ID is missing or malformed, owned by another identity or environment, not allowed, or expired. Rejections use the schema's generic `invalid_contract` error, so the tests confirm rejection, not which field failed.
- Before this, no test exercised `validateEntitlement`; the requirement existed only in code. Earlier contract, signing, storage and billing-adapter suites were already passing (37/37 across them).
- T014 stays unchecked: its wording also covers identity, billing-interface and signing contract finalization, which need review against spec 003 before ticking.

## Subscription ID in billing (2026-11-20)

- Assignment (`billing/service.ts`, paid commit): a first purchase uses its order ID as `subscription_id`; a paid upgrade reuses the quote's `subscription_id`. Upgrade reservations and the `SUB#` record are keyed by the same ID.
- Test added (`tests/billing/adapters.test.ts`, upgrade test): after a plan change the entitlement keeps the same `subscription_id`, and the `SUB#` record stays under that key. A temporary mutation that gives the upgrade a new ID fails the test; the code was restored.
- Open decision: a renewal is a new order with no quote, so the current code gives it a new `subscription_id`. The contract calls the ID stable, and manual-renewal does not say whether a renewal is the same subscription or a new one. Decide before pinning renewal behaviour in a test.

## Subscription ID per paid term (contract update, 2026-11-20)

- Decision: each initial purchase or manual renewal creates a new subscription with its own `subscription_id`. A paid upgrade keeps its source term's `subscription_id` and introduces a new `term_id`.
- Updated wording: `billing/contracts/storage-operations.md` (entitlement row, and the subscription aggregate rule) and `002…/contracts/access-storage.md` (projection field). The earlier "stable aggregate" wording is removed.
- Code: already matches (renewal gets a new order-based ID; upgrade keeps the quote's ID). Tests: the existing upgrade test (ID survives a plan change) still matches; a renewal test (new ID, old record kept) is not yet added.
- Open point to confirm: a paid upgrade is also a payment. The contract keeps its `subscription_id`; if upgrades should also get a new ID, update the upgrade rule.

## Upgrades get their own subscription ID (contract update, 2026-11-20)

- Decision: every paid payment, including a paid upgrade, creates a new subscription with its own `subscription_id`. The source subscription is marked superseded and kept in history.
- Updated: `003…/contracts/storage-operations.md` (entitlement row, aggregate rule, upgrade commit) and `003…/contracts/plan-upgrade.md` (supersede step).
- Not yet aligned: billing code still keeps the source `subscription_id` on upgrades, and `tests/billing/adapters.test.ts` asserts that old rule. Code and that test need changing to match the contract before the contract is treated as implemented.

## Upgrade code aligned to per-payment subscription IDs (2026-11-20)

- `billing/service.ts`: every paid commit (purchase, renewal, upgrade) uses its order ID as the new `subscription_id`, written as a new subscription at revision 1. A paid upgrade also marks the source subscription `superseded` (revision +1, `superseded_by` the new ID), with the same conditional check as before.
- `billing/contracts/storage.ts`: subscription state accepts `superseded`; `superseded_by` is optional.
- `tests/billing/adapters.test.ts`: upgrade test now asserts a new ID, the superseded source, and a paid successor. Billing adapter suite: 21/21.
- Pre-existing, not caused by this change: `tests/billing/contracts.test.ts` (2 failures, service-term examples path) and `tests/access/authorizer_package.test.ts` (1 failure, authorizer path) fail the same way on the last commit when run from this checkout.

## Renewal test (2026-11-20)

- `tests/billing/adapters.test.ts`: a renewal after expiry gets a new subscription ID, the expired term record stays unchanged, the entitlement points at the new ID with a higher revision, and the successor is `paid`. A temporary mutation that reuses the old ID fails the test; the code was restored. Billing adapter suite: 22/22.

## Access image publication evidence (2026-11-22)

- Release `access-2026-11-22.3` from `main` at `2756f4b`, run 45069363579, all steps passed. Image `mcp-access:access-2026-11-22.3`, index digest `sha256:041abeab13665edf9f26d6893c8aa861051410ecc5bb39c1336ad99485972807`; ARM64 manifest `sha256:9afb572e716fe3bcba3349e80bec01ad53044b770db399f727708070bbe4141c`.
- Base image pins: build `node:24-bookworm-slim@sha256:dc26ae92…`, runtime `public.ecr.aws/lambda/nodejs:24@sha256:659129486b70…` (the `24` tag still resolves to this digest, so no newer base exists).
- Scan of the ARM64 manifest: 0 critical, 4 high, 6 medium, 1 low. The high findings are CVE-2026-95520 and CVE-2026-95521 in `rpm` and `rpm-libs` 4.16.1.3-29.amzn2023.0.9, from the Lambda base image. No fixed version is published yet.
- Decision: pin the current base image and accept the two high findings until AWS publishes a patched base. Recheck when the `24` tag moves and rerun the publish.
- Scan-on-push does not cover image indexes, so the scan was run on the ARM64 manifest. Future releases should scan the ARM64 manifest digest.
- T019 stays unchecked: its dependencies (T016–T018) are still open.

## Current access image (2026-11-22, release .4)

- Release `access-2026-11-22.4` from `main` at `7f65079`, run 45071398333, all steps passed including the evidence upload.
- Image `mcp-access:access-2026-11-22.4` is a single ARM64 manifest, digest `sha256:b2acbd7000ff88565e78ec5857a76cede8c09ad79cfd4cec74e9ea7d87ecc51e`. Scan on the tag is complete: 0 critical, 4 high, 6 medium, 1 low; high findings are CVE-2026-95520 and CVE-2026-95521 (`rpm`, `rpm-libs`) from the base image.
- Runtime base pinned to `public.ecr.aws/lambda/nodejs:24-arm64@sha256:1fcf85b0c17215de43e671b3c4dfb405fc46539b21f4e04b87407bc6661019f5`.
- `.2` and `.3` are superseded; `.2`'s evidence was never uploaded and `.3` is an index whose scan is on the ARM64 child only.
- T019 remains unchecked: its dependencies (T016–T018) are open, even though the image and evidence are in place.

## T014 contract review (2026-11-23)

- Entitlement projection: spec 003's logical entitlement table lacked `subscription_id`, which the access contract requires. Added it to `specs/003-billing-subscriptions/contracts/entitlements.md`.
- Identity key: both specs define it as SHA-256 of the canonical JSON array `[issuer, subject]`. Access and billing both build partitions from the shared `contracts/identity.ts` function, and a sample input gives the same key as the canonical-JSON version.
- Billing operations used by access (`listPlans`, `createCheckout`, `getOrder`, `reconcileOrder`, `quoteUpgrade`, `confirmUpgrade`, `manageSubscription`, `openPortal`) all exist in the spec 003 storage contract and billing code. `openPortal` is always `support_required` in this release, as spec 003 requires.
- Signing: RS256 with the `at+jwt` header, an opaque `kid`, a SecureString key, and a 300-second maximum cache, matching `authorization.md`.

## T015–T017 closed (2026-11-23)

- T015: OAuth coordinator tests pass (11 across the OAuth suites), including the new 30-minute session expiry test. The task now names the root `package.json` and lock file, which the access image uses; no separate `access/` package exists.
- T016: token tests pass, including the new negative code-exchange and refresh cases. Resource mismatches return `invalid_target` (RFC 8707); `/authorize` keeps `invalid_request` by decision.
- T017: usage-binding tests (10) and the API Gateway adapter tests (5) pass. The adapter disables SDK retries (`maxAttempts: 1`).

## T018 and T023 progress (2026-11-23)

- T018: onboarding and management suites pass (24 tests across the onboarding, management, and HTTP suites).
- T023: added `tests/access/recovery.test.ts` (a stalled owner whose lease was taken over cannot overwrite the configured binding) and `tests/access/onboarding_callbacks.test.ts` (duplicate, late-after-cancel, and skipped-phase callbacks are rejected). The shared usage-binding fakes moved to `tests/access/support/usage_fakes.ts`. No detached post-return work was found: the remaining timers are request-scoped aborts and client-side polling.
- T022 gap: `onboarding-workflow.md` requires new releases and rollbacks to support existing unexpired records, and incompatible records to fail closed with a repair path. Unknown schema versions fail closed, but the cross-release compatibility test and repair path do not exist yet. T022, T023, and T018 stay unchecked until that policy is decided.

## Record versioning moved to the adapter (2026-11-23)

- `access/adapters/record-codec.ts` now owns `WRITE_SCHEMA_VERSION` (1) and `READ_SCHEMA_VERSIONS` (`[1]`), stamps the write version on every write, and selects the validator for the version read back.
- Domain code (`tokens.ts`, `usage_bindings.ts`, `onboarding.ts`) builds records without a version and no longer calls the validator; `store.ts` encodes and validates on commit and get.
- Test fakes encode through the same codec. New `tests/access/record_codec.test.ts` covers stamping, unknown versions, and unversioned records. Suite: 253 of 253.
- Versions that remain outside the adapter are wire and configuration contracts (`provisioning.ts` budget config, `ports.ts` billing message), not stored records.

## Access record schema version removed (2026-11-23)

- No access records have been written to DynamoDB, so the `schema_version` field and its codec were removed from access records. The access validator now uses its own record base, which rejects any field it does not list, including `schema_version`.
- Billing records keep their `schema_version` (billing has its own storage contract), and the wire and configuration versions are unchanged.
- The onboarding contract still describes multi-version compatibility; it needs the additive-only rule before T022 can close.

## Constitution 1.5.0 and access contract update (2026-11-23)

- Constitution gained Proportionate Design (simplest mechanism the current requirements need; versioning, dual-running, or migration only when a specific change requires it; additive changes preferred).
- Onboarding contract: record changes are additive until a breaking change is planned; failing records fail closed with a repair path. The access-storage contract no longer lists a record `schema_version`.
- Still open: onboarding contract still records "schema/config/handler release versions with durable work". Decide whether to keep it before T022 closes.

## T022 closure (2026-11-23)

- Record compatibility rules live in the storage contract (`access-storage.md#record-compatibility`): additive changes, migration script before breaking changes, fail-closed validation, unknown top-level fields carried through reads and writes, and `delete_after` forbidden on identity profiles and subscriber bindings.
- The onboarding contract keeps only the flow and release process and links to the storage section.
- Local evidence: `npm run check` passes with 269 tests, including the storage and onboarding contract checks. Live DynamoDB rollback and migration behavior remains `not_run`.

## T023 race increment (2026-11-23)

- `tests/access/race.test.ts`: two owners advancing the same transaction revision against a DynamoDB stand-in that evaluates the store's revision conditions. Exactly one write lands; the other is a `TransactionCanceledException`; a stale owner cannot advance a transaction the winner already moved past.
- T023 stays unchecked. Still open from its acceptance list: crash before and after commits and provider calls, expired transactions refusing to advance, late-paid reconnect after cancellation, and browser-closure resume.

## T023 closure (2026-11-23)

- Expiry: `Onboarding` now refuses an expired session or continuation before any checkout, status or resume step (HTTP 409 `session_expired`, because the failure type allows only certain status codes; the session loader still returns 401 for the same expiry).
- Late payment: a failed continuation whose subscription has since become active now returns `continuation_completed`, so the browser restarts sign-in and gets an eligible transaction. Previously it reported `payment_failed`.
- Crash before the intent save: `tests/access/onboarding.test.ts` shows the transaction stays at `identity_verified`, no provider call happens, and a retry completes once.
- Already covered and rechecked: lost billing response after the intent save, concurrent checkout and resume, lease takeover by a stalled owner, and revision races (`tests/access/race.test.ts`). Browser closure is covered by stateless resume: every step reloads persisted state.
- Local evidence only. Live DynamoDB, Stripe and billing behavior remain `not_run`.

## T018 closure (2026-11-23)

- Onboarding and management use cases sit behind the thin HTTP handlers. Local tests cover the payment-plus-binding gate (an entitlement is authoritative only before binding), resume only after binding readiness, mismatched owners, and the management upgrade, downgrade and refund paths delegated to billing.
- Billing implements every operation access calls (`listPlans`, `createCheckout`, `getOrder`, `quoteUpgrade`, `confirmUpgrade`).
- Local evidence only: the live billing invocation, Stripe and Cognito behavior remain `not_run`.

## T019 status (2026-11-23): blocked on local arm64 emulation

- Network: the proxy blocked `public.ecr.aws` and its CloudFront layer host. Both were added to the environment allowlist after your approval card, and the pinned Lambda runtime `public.ecr.aws/lambda/nodejs:24-arm64@sha256:1fcf85b0…` now pulls.
- Build: `docker buildx build --platform linux/arm64` with the pinned `node:24-bookworm-slim@sha256:dc26ae92…` fails at `RUN npm ci` with `exec format error`, because this host has no arm64 binfmt handler. Registering it requires a privileged container, which the session's permission policy denied, so no image or digest evidence was produced here.
- Native check (not the image): `npm ci`, `npm run build`, the Dockerfile's `dist` pruning and `npm prune --omit=dev` all succeed on the host, and the resulting layout contains the directories the Dockerfile copies.
- Next: run the arm64 build on a host with binfmt/QEMU or in the `access-publish` workflow, then record the image digest. Until then T019 stays unchecked.

## T019 publication evidence (2026-11-23)

- Workflow run 45120428758 (`Publish Access Lambda image`, `main` at `cca9c30`, environment `access-publish` approved) succeeded: tests, npm ci, arm64 build and push, and release evidence upload.
- Pushed image: `503098479806.dkr.ecr.ca-central-1.amazonaws.com/mcp-access@sha256:72c0560290fcf11a8bc7b220a41333ec42e24e1541e6dbfb9e976d2efeef7066`, tag `access-2026-11-23.1`.
- Still open before T019 is ticked: the ECR scan-on-push result. The AWS session credentials had expired, so `DescribeImageScanFindings` could not run. The tag mutability and scan-on-push settings also need the same check.

## T019 closure (2026-11-23): accepted base-image findings

- ECR scan of `mcp-access@sha256:72c05602…efeef7066` completed. Repository: tag mutability IMMUTABLE, scan-on-push enabled.
- Findings: 4 HIGH and 6 MEDIUM, all in operating-system packages from the pinned Lambda base image. `rpm`/`rpm-libs` (CVE-2026-95520, CVE-2026-95521, HIGH) and `sqlite-libs` (CVE-2026-119371 to -119378 excluding -119374, MEDIUM). No fixed version is reported.
- Decision: accepted for now and the base image stays pinned, per the project's pin-until-fixed rule. Revisit when AWS publishes a patched `public.ecr.aws/lambda/nodejs:24-arm64` digest; the release then needs a new build and digest.
- Application code and npm dependencies have no findings.

## T005 Cognito deploy (2026-11-23)

- Stack `mcp-access-auth` in `ca-central-1` reached `CREATE_COMPLETE`, deployed from `infra/access/auth.yaml` on `main` (`bb34330`). The Google client secret was entered at the prompt and not stored.
- Outputs: user pool `ca-central-1_XDIAH3aaZ`, public OAuth client `2qu3mfq1kkr9l8n98a1iuemr9i`, hosted login `https://access-mcp-trading-view.auth.ca-central-1.amazoncognito.com`.
- Callback and logout URLs are placeholders (`https://example.invalid/...`). They must be replaced with the REST API's default address once T007 creates it.
- Still open for T005: the authorizer ZIP publish and the access runtime stack.
- Google's registered redirect URI already points at this hosted login domain.

## Authorizer ZIP publication (2026-11-23)

- Run 45124013122 (`publish-authorizer-zip.yml`, tag `authorizer-2026-11-23.2`, `main` at `e6038b4`) succeeded after the `authorizer-publish` environment was configured and approved. An earlier run (`authorizer-2026-11-23.1`) failed at input validation before any AWS call.
- Artifact: `s3://mcp-access-authorizer-releases-503098479806/access/authorizer/authorizer-2026-11-23.2/45124013122-1/authorizer.zip`, version `w_2.3PVnkESEE93aEblBv735oeyqOr29`, 169,187 bytes, latest version.
- T005 stays open: the access runtime stack (`infra/access/runtime.yaml`, image digest `sha256:72c05602…efeef7066`) and the real callback URLs after T007 remain.

## Local closure increment (2026-11-23): T006, T008, T021, bounded retries

- T006: the read-only cutover manifest and its migration fixtures are tested (`tests/access/gateway_cutover.test.ts`); it makes no AWS calls.
- T008: publication workflows are manual, `main`-only, OIDC-protected and grant no deployment rights; both have run successfully (`publish-access-image` run 45120428758, `publish-authorizer-zip` run 45124013122).
- T021: the publication stack (`mcp-access-publication`, UPDATE_COMPLETE) grants the access identity only its ECR repository and the authorizer identity only its S3 prefix; `tests/access/access_publication.test.ts` pins these.
- Provisioning budgets are now bounded: at most 10 attempts, a 25-second provisioning budget (under the 29-second REST proxy limit), and at most 60 seconds of backoff.
- T024 stays open: its acceptance tests pass locally (no access queue, pipe, DLQ, event mapping or replay schedule in any template; exact entitlement grants; bounded retries), but it depends on T005, whose access runtime stack is not yet deployed.

## T025 local simulations (2026-11-23)

- `tests/access/onboarding_journey.test.ts` covers browser closure mid-checkout (a fresh request resumes without a second order), duplicate paid notifications (activation once, no new order), reordered delivery (resume before payment is refused), a plan change after checkout (refused, original order kept), a crash after the provider order but before its save (retried with the same idempotency key), and a late payment after cancellation (never reactivates).
- Shared onboarding fakes moved to `tests/access/support/onboarding_fakes.ts`.
- T025 stays open: its dependency T024 depends on T005, whose access runtime stack is not yet deployed (see T005 notes). T007, T009, T010, T011, T012 and T020 are blocked by the same chain. T013 needs live billing.

## Signing key moved to Secrets Manager (2026-11-23)

- Decision: the access JWT signing key lives in a Secrets Manager secret, not SSM. CloudFormation can't create SecureString parameters, and Secrets Manager can be created from a template.
- `infra/access/signing.yaml` creates the retained secret `mcp-access/signing-key` from a `NoEcho` parameter `SigningKeyJson`, a JSON object `{"version": n, "private_key_pem": "<PKCS8 RSA PEM>"}`. The key is generated outside CloudFormation and is never written to a template or to chat.
- `infra/access/runtime.yaml` takes `SigningSecretArn` and grants the access runtime `secretsmanager:GetSecretValue` on that secret only. The authorizer has no access to it.
- `access/signing.ts` reads `AWSCURRENT` through `secretsSigningLoader`, checks the version, and still verifies the public half against the configured JWK.
- Not yet done: generating the RSA key and creating the stack, the runtime deploy, and the signing config (`secretArn`) in `SigningConfigJson`. These need your approval and the key generation step.

## Signing secret holds the public key too (2026-11-23)

- The secret JSON is now `{"version", "private_key_pem", "public_jwk"}`. The loader rejects the secret unless its `public_jwk` matches the configured `kid`, `n` and `e`, so a stale or swapped public key cannot be served.
- Contracts and the implementation doc describe the new format. `tests/access/signing.test.ts` covers the matching and mismatching cases. Suite: 284 passing.

## Signing key moved to AWS KMS (2026-11-24)

- Decision: the access JWT signing key is an RSA 2048 `SIGN_VERIFY` AWS KMS key, not a Secrets Manager secret or an SSM parameter. KMS generates and keeps the private key, so no operator generates, uploads or sees key material, and no manual console step is needed.
- `infra/access/signing.yaml` creates the retained key `AWS::KMS::Key` and alias `alias/mcp-access-signing`, and outputs `SigningKeyArn`.
- `infra/access/runtime.yaml` takes `SigningKeyArn`. It grants the access runtime `kms:Sign` (conditioned on `RSASSA_PKCS1_V1_5_SHA_256`) and `kms:GetPublicKey` on that key only. Secrets Manager permissions and the optional KMS decrypt path are removed.
- `access/signing.ts` signs with `kmsSigningBackend`: it sends a SHA-256 digest of the JWS signing input with `MessageType: DIGEST`, and checks the public key from `GetPublicKey` against the configured JWK before signing. Telemetry dependency `kms.signing` replaces `secrets.signing_key`. `@aws-sdk/client-secrets-manager` is replaced by `@aws-sdk/client-kms` at 3.1164.0.
- The signing config is now `{keyArn, kid, publicJwk}`. The public JWK comes from the key's `GetPublicKey` output, checked by the runtime at signing time. The `version` field is removed, since rotation means a new key and kid.
- Contracts (`authorization.md`, `managed-infrastructure.md`, `observability.md`) and `docs/access-implementation.md` describe KMS. Suite: 285 passing.
- Not yet done: deploying `signing.yaml`, deriving the public JWK from KMS and entering it in `SigningConfigJson`, the runtime deploy and the authorizer/JWKS wiring. These need your approval.

## CI isolation, task DAG and review (2026-11-24)

- `.github/workflows/test-access.yml` has an isolated `access` job: it requires both lockfiles, runs `npm run check:access` (typecheck plus the access suites), builds the authorizer package, tests the ZIP and lints `infra/access/*.yaml`. A `full` job keeps the complete check with billing and observability. Not yet run on GitHub.
- `tests/access/ci_workflow.test.ts` fails if the access job loses its lockfile guard, its suite run, or its packaging order.
- `tests/access/task_dag.test.ts` fails if a checked task depends on an unchecked task in this list, if a local dependency is missing, or if the list has a cycle. The check found T007 and T024 depending on T005. T005 is now checked: its templates, tables, authorizer and access functions and no-billing-write grants exist and are tested. Its deploy is not part of its task text and is tracked in the operator guide and T013.
- Permission review: the only broad grants in `infra/access` are the KMS key-policy root delegation (`kms:*`, which hands key administration to IAM) and `ecr:GetAuthorizationToken` on `*`, which AWS only supports on `*`. Runtime and gateway grants are scoped to exact ARNs and conditions.
- Retention review: the gap found was that neither the access runtime nor the authorizer Lambda created an explicit log group, so Lambda would create one with no expiry. Both templates now create a retained `/aws/lambda/<FunctionName>` group with `RetentionInDays` from a parameter (default 14), and the function depends on it. The gateway access-log group is also finite. Tested in `access_contract.test.ts`.
- Privacy review: no `console` calls in `access/` or `authorizer/`. The usage key and signing material are only read by the token and binding code, and the redaction and log-shape tests cover their telemetry.
- Suites: `npm run check` passes with 301 tests; cfn-lint passes on `infra/access/*.yaml`.
- Live checks remain separate and `not_run`: GitHub execution of the workflow, real OAuth and code exchange, refresh, subscriber isolation, REST metering, recovery, and release identity (see the operator guide status table and T013).

## Correction: log groups belong to observability (2026-11-24)

- The earlier retention change (CI and DAG section) created `/aws/lambda/<FunctionName>` log groups in `infra/access/runtime.yaml` and `infra/access/authorizer.yaml`, and a gateway access log group in `gateway.yaml`. That duplicated groups that `infra/observability/template.ts` already owns, with the same names and environment-based retention (14 days in production, 3 otherwise). A deploy would have failed with "already exists".
- Removed the duplicates. The access runtime, authorizer and gateway create no log groups. Observability remains the single owner of the access, authorizer and billing function groups and the gateway access and execution groups.
- `gateway.yaml` takes `AccessLogGroupArn` (empty by default). The stage uses access logging only when it is set. Two-pass order: deploy the gateway without it, deploy observability with the gateway's `RestApiId`, then update the gateway with the observability access log group ARN.
- `tests/access/access_contract.test.ts` asserts that these templates create no log groups and that the stage access log is conditional on the parameter. Suite: 301 passing; cfn-lint passes.

## Progress sync (2026-11-24)

- Task count: 24 of 25 checked in `tasks.md`. T013 (live billing recovery, reconnect, cutover and rollback) stays open. It needs live Stripe test-mode, deployed stacks and explicit approval.
- Earlier entries in this file that say "three fully checked" or "stays unchecked" describe those dates. They are superseded by this count.
- Billing side: B001–B013 are checked. Access depends on billing packaging (B010) and publication (B011), both done, and on the billing integration fixtures (B012), also done.
- Deployments: none run in this sync. The status table in `authentication-api-access.md` is the current record of performed and pending steps.


## Correction: gateway owns its access log group (2026-11-25)

- The gateway access log group `/aws/apigateway/<RestApiId>/<StageName>/access` moved from `infra/observability` into `infra/access/gateway.yaml`, which creates the REST API and must name the group from its own ID. The stage always uses it; `AccessLogGroupArn` and the two-pass order are removed.
- The gateway publishes its REST API ID to `/mcp/<env>/access-api/rest-api-id`. Observability reads it at deploy time (`RestApiId` is an SSM-typed parameter), so observability deploys after the gateway and the dependency is one-way.
- Observability still owns the access, authorizer and billing function log groups, the API Gateway execution log group, the telemetry policies, alarms and dashboard. Runtime and authorizer templates still create no log groups.
- Not yet deployed. The `/aws/apigateway/pending/test/access` group created by the earlier observability deploy must be removed manually after observability is redeployed (it is no longer declared, and `Retain` keeps it).
- Suite: 330 passing (Node 24); `cfn-lint` passes on `gateway.yaml` and the regenerated observability template.

## Signing public key derived at runtime from the ARN (2026-11-25)

- `infra/access/signing.yaml` publishes only the key ARN (`/mcp/<env>/access/signing-key-arn`). CloudFormation has no native attribute for a KMS public key, so no public key is stored in SSM and no custom resource is used.
- The access runtime reads that ARN with `ssm:GetParameter` (Standard String, so no `kms:Decrypt`), calls `kms:GetPublicKey` on it, and converts the SubjectPublicKeyInfo to a JWK with `jose`. The `kid` is derived from the public key, so it is stable for a given key.
- The ARN is read once per execution environment, and the JWK derived from it is cached in memory. Later requests use the cached JWK with no AWS call. Failed reads are not cached. A changed parameter takes effect in new environments after a runtime redeploy.
- `infra/access/runtime.yaml` now grants `ssm:GetParameter` on the signing-key-arn parameter and sets `ACCESS_SIGNING_KEY_ARN_PARAMETER`.
- Superseded: the pinned `publicJwk` in `SigningConfigJson`, the `PublicJwksJson` runtime input, and the 300-second KMS re-check. `access/signing.ts`, `access/app.ts`, `access/handler.ts`, `/jwks.json` and their tests now use the ARN-derived key; `infra/access/runtime.yaml` no longer takes `PublicJwksJson` or `SigningConfigJson`. `npm test` passes on Node 24 (332 tests).
- Not deployed. Runtime deploy needs your approval.

## Billing mapping source (2026-11-25)

- Usage plans come from the gateway template and publish their IDs to SSM; Stripe prices are created after the plan exists and carry its ID in metadata; the publish step verifies those links and assembles the catalog. The rules are in `specs/003-billing-subscriptions/contracts/plan-catalog.md` (Mapping source and publication).
- Not implemented: the per-tier usage plans, the verification step, and the catalog assembly. Nothing is deployed. The access runtime still waits on its `AccessConfigJson` inputs and approval.

## Stripe is the billing mapping authority (2026-11-25)

- Approved amendment: Stripe products and prices, with their metadata, are the authority for plans, durations and usage-plan mapping. The SSM catalog is retired as a runtime source. Details are in `specs/003-billing-subscriptions/contracts/plan-catalog.md` (Stripe authority amendment).
- Not implemented: the billing code changes, the Stripe verification command, and removing the catalog stack. Nothing has been changed in Stripe or AWS.
- Billing code: the catalog is now built from Stripe in `billing/adapters/stripe-catalog.ts` and tested (342 tests pass on Node 24). The SSM catalog template and the runtime's catalog env are still deployed artifacts; removing them is a follow-up. Nothing is deployed.
- Billing gaps 1, 3, 4 and 6 closed: excluded-object logging, changed-price detection at checkout, deployed REST API/stage filtering, and the read-only Stripe verifier. 346 tests pass on Node 24. Nothing is deployed; the billing runtime now needs the `RestApiStage` input.
- Gateway publishes its stage to `/mcp/<env>/access-api/stage`; billing reads the REST API ID and stage from SSM. `RestApiStage` is removed as a billing deploy input. 349 tests pass on Node 24. Nothing is deployed.
