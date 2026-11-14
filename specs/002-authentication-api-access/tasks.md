---
description: "Pending REST access, Cognito/OAuth coordination and native subscriber usage-plan work"
---

# Tasks: Authentication and API Access

**Spec**: [spec](spec.md) · [plan](plan.md) · [client contract](contracts/client-onboarding.md) · [REST contract](contracts/rest-gateway.md) · [migration history](../../../tradingview-mcp/specs/scope-migration.md)
**Status and coverage**: [status.md](status.md) holds dated progress, local evidence and the per-task requirement map. Checkbox states here are authoritative: 3 of 25 checked (T002–T004). All current verification is local; live and provider checks are `not_run`.

## Foundations and authorizer

- [x] T001 Write access boundary, REST and observability infrastructure tests for ownership, alias permissions, retained state, acyclic wiring, role separation and absence of Step Functions resources. Files: `tests/access/access_contract.test.ts`.
- [x] T002 Write isolated token, JWKS and authorizer tests covering wrong resource/client/type, expiry, usage-key tampering, unavailable keys, exact REST methodArn, and zero datastore or MCP calls on denial. Files: `tests/access/authorizer.test.ts`, `tests/access/support/identity_fixture.ts`. Depends: T001, T014.
- [x] T003 Implement the isolated Node.js REST REQUEST handler with JWT and JWKS verification and signed usage-key validation, with no datastore, Stripe or MCP imports. Files: `authorizer/handler.ts`, `authorizer/package.json`, `authorizer/package-lock.json`. Depends: T002.
- [x] T004 Build and test an npm-locked Node.js 24.x ARM64 authorizer ZIP with production dependencies only and recorded SHA-256 evidence, exercised without Docker. Files: `infra/access/package-authorizer.ts`, `infra/access/zip.ts`, `scripts/package_authorizer.mjs`, `tests/access/authorizer_package.test.ts`. Depends: T003.

## Identity, REST gateway and cutover

- [ ] T005 Implement retained Cognito reuse, PKCE callback configuration, signing-key JWKS, the single AccessState table, and Node.js ARM64 authorizer and access functions with no billing-write grants. Files: `infra/access/auth.yaml`, `infra/access/authorizer.yaml`, `infra/access/release-authorizer.ts`, `tests/access/access_contract.test.ts`. Depends: T004, T015, T017, T019.
- [ ] T006 Write migration fixtures, then implement a read-only cutover manifest for distinct legacy HTTP and REST targets that rejects conflicting resources and makes no automatic changes. Files: `scripts/prepare_gateway_cutover.ts`, `tests/access/gateway_cutover.test.ts`. Depends: T001.
- [ ] T007 Write then implement the phased REST gateway: REQUEST authorizer, CUSTOM paid methods, public discovery and OAuth routes, exact alias integrations, a 29-second proxy, stage logs and tier plans, with no HTTP payload-format fields. Files: `infra/access/gateway.yaml`, `tests/access/access_contract.test.ts`. Depends: T005, T006, T018, T024, and the spec-001 T052 alias contract.

## Publication and evidence

- [ ] T008 Add manual, OIDC-protected publication workflows that build the authorizer ZIP and access image once, upload them with checksum and digest evidence, and grant no deployment or billing rights. Files: `.github/workflows/publish-authorizer-zip.yml`, `.github/workflows/publish-access-image.yml`, `tests/access/access_publication.test.ts`. Depends: T004, T019, T021.
- [ ] T009 Write then implement separate local and read-only live verification for discovery, OAuth, refresh, privacy, subscriber isolation, REST plans, release identities and recovery outcomes, without asserting hard quotas. Files: `scripts/verify_access.ts`, `tests/access/access_verifier.test.ts`. Depends: T007, T008, T020, T025.
- [ ] T010 Document the bootstrap, registered-host PKCE and payment flow, token and revocation bounds, billing recovery, compatible rollback, and REST cutover, marking every unperformed cloud or provider step. Files: `docs/authentication-api-access.md`, `specs/002-authentication-api-access/quickstart.md`. Depends: T006, T007, T008, T009.
- [ ] T011 Add a required isolated CI workflow that typechecks, builds and runs the access and authorizer suites, and fails when selected dependencies or checks are missing. Files: `.github/workflows/test-access.yml`, `tests/access/`, `access/package.json`, `authorizer/package.json`. Depends: T008, T009.
- [ ] T012 Run the expanded local and native suites with the DAG, permission, retention and privacy review, and document pending live checks separately from earlier service tests. Files: `tests/access/`, `specs/002-authentication-api-access/tasks.md`. Depends: T010, T011.
- [ ] T013 Validate live billing recovery, reconnect, subscriber plans, cutover and rollback with real prerequisites; local runs leave this `not_run` and move no real charges. Files: `docs/authentication-api-access.md`, `/tmp/tradingview-access-evidence/live.json`. Depends: T012, spec-003 payment acceptance, spec-001 REST acceptance.

## OAuth coordination and activation prerequisites

- [ ] T014 Finalize and test the cross-feature physical state, identity, billing-interface and signing contracts, plus the stable subscription ID in the entitlement projection, before dependent adapters. Files: `access/`, `tests/access/oauth_contract.test.ts`, `specs/002-authentication-api-access/contracts/`. Depends: T001 and spec-003 technical planning.
- [ ] T015 Write OAuth tests, then implement the Express coordinator for client registration, metadata, authorize and Cognito callback, JWKS, and the 30-minute onboarding session, with routes as thin adapters. Files: `access/http/`, `access/handler.ts`, `access/ports.ts`, `access/identity.ts`, `access/package.json`, `access/package-lock.json`, `tests/access/oauth.test.ts`. Depends: T014.
- [ ] T016 Write token and revocation tests, then implement one-use code exchange, PKCE binding, paid-bound JWTs with usageIdentifierKey, rotating refresh credentials and RFC 7009 revocation. Files: `access/tokens.ts`, `access/grants.ts`, `tests/access/tokens.test.ts`. Depends: T015, T017.
- [ ] T017 Write provisioning tests, then implement idempotent per-subscriber key creation and usage-plan binding behind ports, with a native API Gateway adapter and sanitized retries. Files: `access/usage_bindings.ts`, `access/provisioning.ts`, `tests/access/usage_bindings.test.ts`. Depends: T014 and spec-003 entitlement contract.
- [ ] T018 Write integration tests, then implement onboarding and paid-management use cases behind thin Express controllers and internal billing ports, covering payment-plus-binding gates and resume. Files: `access/onboarding.ts`, `access/management.ts`, `tests/access/onboarding.test.ts`, `tests/access/management.test.ts`. Depends: T015, T016, T017, T023, and spec-003 internal operations.
- [ ] T019 Build and test a pinned, npm-locked ARM64 access image with digest evidence, excluding credentials, card data and MCP imports. Files: `access/Dockerfile`, `access/Dockerfile.dockerignore`, `tests/access/access_container.test.ts`. Depends: T016, T017, T018.
- [ ] T020 Implement local full-journey simulations joining client S256, Cognito, billing order, entitlement, refresh and REST authorization against a mock MCP, including adversarial and expiry cases. Files: `tests/access/client_journey.test.ts`. Depends: T007, T019, T025, and spec-003 simulated billing acceptance.
- [ ] T021 Finalize scoped publishing roles so the authorizer identity writes only its S3 prefix and the access identity publishes only its ECR repository, with no deployment or cross-component rights. Files: `infra/access/publication.yaml`, `tests/access/access_publication.test.ts`. Depends: T001 and the spec-001 publishing-IAM interface.

## Persisted onboarding and background recovery

- [ ] T022 Validate the access-storage record schemas and onboarding contract, including phase and revision guards, atomic writes and compatibility across releases, with no access-owned queue, outbox or schedule. Files: `tests/access/onboarding_contract.test.ts`, `specs/002-authentication-api-access/contracts/onboarding-workflow.md`. Depends: T014.
- [ ] T023 Write crash and race tests, then implement shared transaction transitions, bounded status and resume, lease fencing, and recovery with no detached post-return work. Files: `access/transitions.ts`, `access/provisioning.ts`, `tests/access/onboarding_callbacks.test.ts`, `tests/access/recovery.test.ts`. Depends: T022, T015, T016, T017, and spec-003 reconciliation interface.
- [ ] T024 Write then enforce the absence of any access queue, Pipe, DLQ, SQS mapping or replay schedule, and validate exact entitlement read grants and bounded provisioning retries. Files: `tests/access/access_contract.test.ts`, `tests/access/onboarding_contract.test.ts`. Depends: T005, T022, T023.
- [ ] T025 Run local handler, state and recovery simulations for browser closure, duplicate and reordered delivery, crashes, lease expiry, late payment and plan changes, separating fixtures from live event behavior. Files: `tests/access/onboarding_journey.test.ts`, `tests/access/onboarding_contract.test.ts`, `tests/access/recovery.test.ts`. Depends: T023, T024, and spec-003 simulated fixtures.

## Dependency order

The order is T001 → T014 → (T002 → T003 → T004; T015; T017; T006; T021; T022) → T016 → T023 → T018 → T019 → T005 → T024 → T007 → (T008; T025) → T020 → T009 → T010 → T011 → T012 → T013. External spec-003 billing and spec-001 REST work are prerequisites for cross-stack evidence. Progress notes and per-task requirement coverage are in [status.md](status.md).
