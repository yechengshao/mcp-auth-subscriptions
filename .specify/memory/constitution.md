# MCP Auth and Subscriptions Constitution

## Core Principles

### Concise, Precise Documentation

- Each `spec.md` MUST target 500 words; `spec.md` and `plan.md` MUST each stay under
  800 words unless essential requirements require more. Any exception MUST include a
  brief justification in the affected document.
- Each requirement MUST have one authoritative location; other documents MUST link
  to it instead of repeating it.
- Each task MUST use one actionable sentence, adding paths and dependencies only
  when necessary. A task line SHOULD stay under 60 words including its paths,
  dependencies and requirement references; move acceptance detail to the contracts.
- `tasks.md` SHOULD stay under 2,500 words. Exceeding that budget requires a brief
  justification in the file, as specs do.
- `tasks.md` MUST hold only task lines and their checkbox state; progress evidence and verification logs belong in `docs/` or a feature status file, and specs state requirements only.
- Documents MUST describe current decisions and omit generic advice,
  conversational history, and redundant summaries; retain history only when needed
  for compatibility or migration.
- Brevity MUST NOT remove security boundaries, failure behavior, testable acceptance
  criteria, or necessary implementation details.
- Revisions MUST preserve existing requirement/task IDs and completion states.

### Idempotent, Resumable Operations

- User workflows MUST allow safe retries and reconnection using durable server-side
  state; completion MUST NOT depend on keeping a browser, HTTP request or Lambda
  invocation open through payment, propagation or human delays.
- Each request MUST perform bounded work and return a completed, pending, denied or
  retryable outcome. Pending responses MUST identify how to resume and provide
  bounded retry/backoff guidance; no detached post-return work or process-local timer
  may carry required progress.
- Retries, concurrent requests and duplicate/reordered events MUST NOT duplicate
  purchases, charges, native usage keys, provisioning effects or credential grants.
  Use stable operation identity, conditional state/revision checks and recoverable
  leases where needed; repeated calls may return the same result, current progress
  or a safe rejection rather than repeat an effect.
- Uncertain external effects MUST be reconciled against authoritative provider and
  persisted state before retrying; a timeout alone is not proof that an effect failed.
  Security one-use codes and rotating refresh credentials MUST retain replay rejection.
- Confirmed payment/subscription state MUST survive browser closure, expired login
  continuations and application retries. Eligible reconnect MUST reuse the existing
  subscription rather than require another purchase; expired continuations require
  fresh authorization and MUST NOT be revived or extended by retries.
- Prefer request-driven retry/resume for access activation. Background queues or
  schedules MAY be used when work must progress without user requests, such as
  payment reconciliation, but their necessity and recovery guarantees MUST be explicit.
  Retryability MUST NOT bypass current eligibility, ownership, CSRF or expiry checks.

### Hexagonal Architecture

- Lambda entrypoints MUST compose dependencies and adapt invocation data; they MUST NOT contain workflow decisions.
- HTTP routes and native-event handlers MUST validate their transport, call application use cases and map results to protocol responses.
- Application and domain logic MUST depend on local ports, not Express or cloud-provider SDKs; outbound adapters implement those ports, with dependency direction pointing inward.
- Keep AWS integrations, provider calls and telemetry at explicit boundaries. This pattern MUST NOT create a separate Lambda for each layer or require a class for every function.
- Validate use cases independently of live cloud services, and validate adapters at their integration boundaries.

### Infrastructure as Code

- Every AWS resource MUST be defined in a CloudFormation template in the repository and created or changed only by deploying that template. Resources MUST NOT be created by hand in the console or by ad hoc CLI commands.
- Deployments MUST use reviewed template versions and MUST NOT use root account credentials.
- Account-level bootstrap (for example, enabling billing or SSO) is the only exception and MUST be documented.

## Documentation Scope

Apply these rules to future generated or revised specifications, plans, tasks, and
supporting contracts. Keep requirements in specifications, implementation decisions
in plans/contracts, and execution steps in task lists. Add supporting documents or
diagrams only when they clarify necessary detail without repeating existing content.

## Compliance Review

Before finishing an artifact, check its word budget, remove repetition, and confirm
that requirements, task states, and essential security/failure details remain intact.
Review retry/concurrency, uncertain-effect recovery, browser closure and reconnect
acceptance without weakening replay protection or duplicating paid effects.
This adoption does not automatically rewrite existing feature documents.

## Governance

These rules govern Spec Kit documentation in this project. Amendments MUST record
the changed rule, rationale, version, and amendment date. Use a major version for
incompatible rule changes, a minor version for new or expanded principles, and a
patch version for clarifications. Reviews MUST check compliance with this constitution.

## Amendment Record

- **1.1.0 — 2026-11-06**: Added Idempotent, Resumable Operations and corresponding
  compliance review. Rationale: users must be able to retry or reconnect without
  holding requests open, losing confirmed payment or repeating side effects; keep
  autonomous payment recovery distinct from request-driven access activation.
- **1.2.0 — 2026-11-10**: Added Hexagonal Architecture. Rationale: separate Lambda/HTTP transport, workflow decisions and AWS/provider integrations so each boundary remains replaceable and reviewable without multiplying functions.
- **1.3.0 — 2026-11-10**: Added soft length budgets for task lines (under 60 words) and `tasks.md` (under 2,500 words), with justification required to exceed them. Rationale: the access task list had grown to paragraphs of acceptance detail, obscuring task status.
- **1.2.1 — 2026-11-10**: Clarified that `tasks.md` holds only task lines and checkbox state, with progress evidence in `docs/` or a status file. Rationale: task files had accumulated dated evidence logs, which made counts and status drift out of sync.
- **1.4.0 — 2026-11-13**: Added Infrastructure as Code: AWS resources only from CloudFormation templates, no root credentials, documented bootstrap exceptions. Rationale: first deployments are at risk of console-created or untracked resources.

**Version**: 1.4.0 | **Ratified**: 2026-11-04 | **Last Amended**: 2026-11-13
