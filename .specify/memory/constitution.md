<!--
Sync Impact Report (temporary review note; remove before committing):
Version change: not established -> 1.0.0 (initial adoption).
Added principle: Concise, Precise Documentation.
Added sections: Documentation Scope; Compliance Review; Governance.
Removed: unused template placeholders/examples; no adopted rules removed.
Dependent templates/commands: unchanged; live constitution is the policy source.
Follow-up TODOs: none.
-->

# MCP Auth and Subscriptions Constitution

## Core Principles

### Concise, Precise Documentation

- Each `spec.md` MUST target 500 words; `spec.md` and `plan.md` MUST each stay under
  800 words unless essential requirements require more. Any exception MUST include a
  brief justification in the affected document.
- Each requirement MUST have one authoritative location; other documents MUST link
  to it instead of repeating it.
- Each task MUST use one actionable sentence, adding paths and dependencies only
  when necessary.
- Documents MUST describe current decisions and omit generic advice,
  conversational history, and redundant summaries; retain history only when needed
  for compatibility or migration.
- Brevity MUST NOT remove security boundaries, failure behavior, testable acceptance
  criteria, or necessary implementation details.
- Revisions MUST preserve existing requirement/task IDs and completion states.

## Documentation Scope

Apply these rules to future generated or revised specifications, plans, tasks, and
supporting contracts. Keep requirements in specifications, implementation decisions
in plans/contracts, and execution steps in task lists. Add supporting documents or
diagrams only when they clarify necessary detail without repeating existing content.

## Compliance Review

Before finishing an artifact, check its word budget, remove repetition, and confirm
that requirements, task states, and essential security/failure details remain intact.
This adoption does not automatically rewrite existing feature documents.

## Governance

These rules govern Spec Kit documentation in this project. Amendments MUST record
the changed rule, rationale, version, and amendment date. Use a major version for
incompatible rule changes, a minor version for new or expanded principles, and a
patch version for clarifications. Reviews MUST check compliance with this constitution.

**Version**: 1.0.0 | **Ratified**: 2026-11-04 | **Last Amended**: 2026-11-04
