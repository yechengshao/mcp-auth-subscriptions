# Analysis: Access and Billing Specifications

**Scope**: Local specs 002/003, plans, contracts, tasks and readiness/reminder drafts; read-only cross-check of service spec 001 REST prerequisites. No application code, AWS operation or acceptance test executed. Initial analysis was read-only. The user subsequently authorized the contract fixes below; prior uncommitted checklist/reminder changes are preserved. No application or deployment implementation has been performed.

## Result

All six findings are resolved at the contract level after the authorized remediation and recheck below. Proceed to B001/access boundary and schema fixtures. This is planning readiness, not proof of implemented concurrency, provider behavior, payments or live interoperability. No activation queue or automated refund was introduced. A subsequent user-directed simplification consolidates storage into AccessState, BillingState (including decision history) and BillingEntitlements, retaining per-record TTL, transaction keys and table-level entitlement isolation.

| ID | Severity | Finding | Consequence / recommended resolution |
|---|---|---|---|
| A01 | High | Provisioning fencing is specified for DynamoDB commits, but not for delayed AWS side effects after an operation timeout/lease takeover. | A stale invocation can still issue native association mutations even when it cannot commit local state. Define durable operation-generation/uncertain-effect exclusion before allowing a newer tier operation, recovery ordering and conflict handling; test a late native completion overlapping a newer entitlement. Do not add routine successful-call probes or pretend DynamoDB fences AWS. |
| A02 | High | Upgrade quote, credit reservation and consumed-credit ledger have behavioral rules but no physical records/keys/conditional transaction definition in the billing storage contract. | The machine-schema task cannot fully specify one-use credit/concurrent upgrades yet. Add exact records and atomic source-revision/reservation/consume rules, reference them in B001/B009, and test concurrent confirmation and late payment. |
| A03 | Medium | Native outcome enum excludes support_required, catalog_changed and unsupported_credit_case, while endpoint/upgrade contracts require those results. | Implementations could reject legitimate responses or lose the support flow. Choose one discriminated result/error vocabulary and HTTP/UI mappings, distinguishing provider failure, re-quote and support-only cases; add invalid/valid fixtures. |
| A04 | Medium | Portal and support scope is inconsistent: endpoint/tasks disable the portal, but billing storage still conditionally permits openPortal and manual-renewal text suggests a restricted cancellation operation. | Could lead to unwanted portal or financial-mutation implementation. State that the application only renders support contact for these requests; mark openPortal unavailable and keep agent-operated refund procedures outside application tasks. |
| A05 | Medium | Billing work Pipe accepts inserts/updates while the consumer and replay can also enqueue delayed successors; a concrete bounded scheduling-generation rule is absent. | Business-effect idempotency alone does not bound duplicate queue traffic. Define due-work generation/claim and re-enqueue rules to prevent repeated early hints from multiplying delayed jobs; test Pipe update + duplicate consumer + replay together. Keep at-least-once recovery. |
| A06 | Medium | Duration options require unit/count/time semantics, but supported units, field types and calendar/rounding rules remain prose rather than a closed validation contract. | B001/B003 need an implementable term model and boundary fixtures. Define supported fixed/calendar term rules and reject unsupported variants before sale; actual plan durations/prices may remain operator inputs. |

## Resolution and recheck

| ID | Contract resolution | Acceptance still required in implementation |
|---|---|---|
| A01 | Access storage defines persistent external mutation generation/step, dispatch evidence, uncertain-effect quarantine and read-only lease takeover; unresolved old calls block conflicting generations and can require support. Routine successful calls still need no probe. | Simulate late stale AWS calls, missing acknowledgments and concurrent subscription revisions; local fences must never be presented as AWS-side fencing. |
| A02 | Billing storage defines exact upgrade-quote, per-subscription reservation and per-source-term consumed-credit records, plus atomic reserve/apply/release conditions. | Verify two concurrent quotes, duplicate payment/reconcile, reservation expiry with live Checkout, and late paid conflicts in real emitted handlers. |
| A03 | One native result vocabulary now includes support_required; catalog_changed and unsupported_credit_case are error codes, with explicit JSON HTTP/UI mapping and separate OAuth/webhook rules. | Machine result schemas and valid/invalid operation fixtures in B001; no raw errors or unwanted financial mutation. |
| A04 | Portal is unavailable in this release, and refund/cancellation support uses external operational tools; no application agent refund/cancel API is required. Specs/contracts/tasks align. | Enforce backend and UI action allowlists, disabled portal and safe support contact. |
| A05 | INSERT-only Pipe emits dispatch_hint; Checkout, hints and replay share one generation/lease-fenced publisher, sent/delivery grace and capped ambiguous-send retries. Early/duplicate deliveries never recursively re-enqueue. | Race/partial-batch/SendMessage ambiguity/old-generation redrive tests, live queue/Pipe validation and bounded recovery configuration. |
| A06 | Closed service-term JSON Schema defines day/month/year bounds, UTC fixed-day versus direct calendar clamping, exclusive expiry and rejection rules. Valid/invalid and calendar reference vectors are saved. | Application term calculator and full catalog validator must pass these and further property/boundary tests before any offer can be sold. |

**Executed recheck:** JSON Schema meta-validation; 6 valid and 14 invalid schema vectors; 6 independent UTC/calendar reference vectors; all 60 requirement references; unchanged IDs/states across 39 implementation tasks; no mapped dependency cycles; relative file links, both plan word limits and whitespace checks. All passed. Calendar vectors validate the written rule/reference calculation, not a nonexistent application implementation. Live/provider/handler integration remains not_run.

**Residual review result:** no unresolved A01–A06 specification blockers found on this pass. Operator catalog values/resource IDs, chosen deployment budgets, separately scoped service REST work and live client/provider acceptance remain prerequisites at their proper stages. Conservative support/repair handling remains required for external outcomes that cannot be proven safe; this is not an automatic-resolution guarantee.

## Evidence

- **A01:** [Access storage](002-authentication-api-access/contracts/access-storage.md), binding/atomic operation rule 6; [onboarding](002-authentication-api-access/contracts/onboarding-workflow.md), durable-state lease/revision rules. Local fencing is explicit; external AWS calls are explicitly outside the database transaction, but takeover/late-call ordering is not finalized.
- **A02:** [Paid upgrades](003-billing-subscriptions/contracts/plan-upgrade.md), quote/credit reservation and atomic consumption; [billing storage](003-billing-subscriptions/contracts/storage-operations.md), table rows and commit algorithm. Existing generic order/work fields do not specify the reservation's exact uniqueness/transaction boundary.
- **A03:** [Billing storage](003-billing-subscriptions/contracts/storage-operations.md), native result enum; [endpoints](002-authentication-api-access/contracts/endpoints.md), management support results; [catalog](003-billing-subscriptions/contracts/plan-catalog.md) and [upgrades](003-billing-subscriptions/contracts/plan-upgrade.md), quote/version/credit exceptions.
- **A04:** [Endpoints](002-authentication-api-access/contracts/endpoints.md), portal disabled; [billing tasks](003-billing-subscriptions/tasks.md), B009; [billing storage](003-billing-subscriptions/contracts/storage-operations.md), openPortal; [manual renewal](003-billing-subscriptions/contracts/manual-renewal.md), support boundary.
- **A05:** [Billing storage](003-billing-subscriptions/contracts/storage-operations.md), work-stream filter on inserts/updates; [delivery](002-authentication-api-access/contracts/background-delivery.md), delayed re-enqueue and scheduled replay.
- **A06:** [Catalog](003-billing-subscriptions/contracts/plan-catalog.md), service_term; [manual renewal](003-billing-subscriptions/contracts/manual-renewal.md), verified payment timestamp plus configured term semantics.

## Coverage and dependency checks

- Spec 002: 21 functional requirements + 10 success criteria; 25 unchecked implementation tasks.
- Spec 003: 20 functional requirements + 9 success criteria; 14 unchecked implementation tasks.
- All 60 requirement/criterion IDs appear in their feature task lists. This is reference coverage, not proof that every behavior is adequately tested; the findings above still need acceptance fixtures.
- No cycles found in the 39-task local graph plus mapped access/billing prerequisites. External service REST transport/IaC/report work remains a real dependency; it was not marked complete.
- Both plans remain under 800 words. Main specs retain their documented length exceptions; relative file links and whitespace checks pass.
- Four-function scope, billing-only SQS, request-driven activation, local signing, one-hour JWTs, manual renewal, selectable durations and support-only refunds agree at architecture level.

## Nonblocking inputs and validation still pending

Real catalog values, Stripe/AWS identifiers, client callbacks/domains, configured support email, deployment budgets/retention and secrets are production inputs, not blockers to local schema development. Live ChatGPT/Claude refresh/reconnect, AWS native key uniqueness/association behavior, payment webhooks, queue/replay and telemetry require separate acceptance; the saved renewal reminder is not_run. Financial cases without an unambiguous upgrade-credit calculation remain support-only and must not create Checkout.

## Post-consolidation plan review

User approved three physical tables across two data domains. Rechecked the revised main specs, plans, infrastructure/data contracts and tasks: one AccessState table; BillingState including immutable history; separate BillingEntitlements; no separate history table or access activation infrastructure. Logical access record groups retain their original key namespaces and per-entity lifetimes rather than becoming new tables.

Nine targeted checks passed: one access table, two billing tables, persistent rows omit TTL, history shares BillingState, only reconciliation-work INSERTs route to billing SQS, access has no BillingState grants, verified billing/projection writes are atomic, T005 targets one AccessState, and B002 targets two billing tables. Schema validation still passes 6 valid/14 invalid examples and 6 UTC/calendar reference vectors. All 60 requirement references, 39 unchecked task states, mapped dependency acyclicity, relative links, plan word limits and whitespace checks remain valid.

No additional planning blockers found in this scoped recheck. A01–A06 remain resolved at the contract level; this review does not prove provider behavior, concurrency correctness or deployed monitoring. The next development step is B001 plus access boundary/schema fixtures, followed by runtime acceptance of the documented transaction/recovery cases. No implementation task was checked off, no cloud resource created and no payment performed.

## Recommended order

### Shared-session implementation review — 2026-11-08

The shared session contract aligns with the access storage and endpoint contracts: one 30-minute absolute session mechanism, purpose-bound transaction routing, identity verification before management, current entitlement/ownership checks and no MCP-token handoff. Expired mutation replay and atomic session rotation remain handler acceptance requirements, not schema guarantees.

The first [local contract foundation](../billing/contracts/README.md) adds executable schemas, synthetic fixtures and tests for catalog scope/durations, purchased snapshots, selected database records, native requests/failures, queue references, UTC term calculation and session/management expiry/ownership boundaries. Full B001/T014 schemas and conditional transaction implementations remain unfinished; all 39 task checkboxes retain their prior state. Provider, IAM, cookie/Cognito, queue delivery and host-reconnect acceptance remain not_run.

Review/commit the remediated planning baseline when requested, then start B001/access boundary fixtures. Carry each resolution's runtime acceptance cases into implementation; keep all implementation/live tasks unchecked until executed with evidence. This remediation does not authorize deployment, payments, support emails or external notifications.

## B001 completion review — 2026-11-08

The [contract implementation](../billing/contracts/README.md) now covers all 12 billing and 8 access record kinds with exact scoped keys, closed fields, cleanup rules and positive/negative fixtures; canonical native results; quote/reservation/credit/work metadata; required bounded budgets; projection-only read/alias grant fragments; and versioned, bounded catalog caching with injected loader/clock. Sixty local tests pass, including all existing service-term vectors and calendar arithmetic, identity/session binding, unsupported financial paths and secret-sentinel rejection. TypeScript typecheck/build pass.

B001 is complete at its contract/schema prerequisite scope; the other 38 tasks remain open. Neither schema validation nor pure grant fragments implement atomic DynamoDB updates, provider verification, actual IAM, cookies/CSRF, queue delivery or logging/tracing adapters. These remain their owning tasks, with live CloudWatch/X-Ray, Stripe, Cognito and host acceptance not_run. The next billing task is B002 retained storage IaC, with B003 lifecycle/policy implementation following the approved dependency order; access T001/T014/T022 boundaries remain unfinished.

## AWS-native monitoring foundation — 2026-11-08

User chose AWS-native monitoring only. [Logging helpers and prepared IaC](../observability/README.md) use Node standard libraries, CloudWatch JSON/EMF and native Lambda/REST X-Ray settings; no OpenTelemetry, external tracing SDK, custom segment/exporter, collector or monitoring worker remains. Existing AWS trace metadata and saved correlation IDs are relayed without manufacturing application spans. Native invocation/service tracing is coarser; safe log timings cover application failures.

The prepared template retains finite logs, native sampling, scoped policies and bounded dashboard/alarms. Business handlers, stage/role wiring and actual transition/metric callsites remain pending. Local redaction/context/template tests do not establish native graph propagation or cloud delivery. B001 remains the only completed full task, with 38 open; no cloud deployment, payment or notification occurred.

Native-only validation: 77 auth/billing tests with typecheck/build and cfn-lint; relayed AWS headers parse consistently in both projects without a tracing SDK. Live graph/header propagation and handler integration remain unverified.
