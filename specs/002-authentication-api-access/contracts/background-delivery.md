# Contract: Four Lambdas and Durable SQS Delivery

**Status**: Planned, not implemented. This contract owns function boundaries and background transport; onboarding owns transition guards and billing owns provider authority. No infrastructure is provisioned by this revision.

## Function inventory

| Function | Spec | Responsibility |
|---|---|---|
| MCP | 001 | Market-analysis MCP transport/tools; no identity/billing permissions |
| Access | 002 | Express discovery/OAuth/session/token/status/resume plus native SQS activation/provisioning and scheduled replay handlers |
| Authorizer | 002 | Direct REQUEST JWT validation and signed usageIdentifierKey response; no datastore access |
| Billing | 003 | HTTP Stripe webhook, trusted native operations, SQS payment reconciliation and scheduled billing-work replay |

Access reuses ONE function, version/alias and execution role for HTTP, activation, provisioning and replay; there is no separate access worker or recovery function. The role intentionally combines signing-key read, access-state writes, entitlement/outbox reads, exact billing invocation and native usage-key/plan management plus activation SQS permissions. This is not IAM isolation between HTTP and background handlers. Authorizer, billing and MCP retain distinct roles; access has no Stripe secrets or billing-write grants. Shared TypeScript modules dispatch at the trusted invocation boundary: only HTTP events enter Express, SQS and schedule events invoke native handlers. Never select background dispatch from HTTP body fields. Background code must not issue tokens or redirect users even though it shares the function role.

## Queues and managed routing

Use Standard queues `AccessActivationQueue` and `BillingReconcileQueue`, each with a separate dead-letter queue. Access background IaC owns the activation queue/DLQ, Lambda SQS mapping and managed EventBridge Pipes from billing activation outbox and access work streams. Billing background IaC owns reconciliation queue/DLQ, SQS mapping and its work-stream Pipe. Pipes use filters and input transforms to publish only durable record references; no routing Lambda is added. Storage is provisioned before pipes; outputs are injected after function/queue aliases exist without reverse stack imports.

Message v1 fields: schema_version, kind, environment, durable_record_key, operation_id and correlation_id. Kinds are activation/provisioning for access and reconcile_payment for billing. A message is a hint: consistently load its owned durable record, verify identity/order/revision/schema/environment and claim the fenced lease before effects. Never trust a queue-supplied identity/status/price or put tokens, keys, provider payloads or payment secrets into messages. Queue policies restrict producers, mappings restrict consumers, and Pipe roles have only selected stream-read and target SendMessage actions.

AWS Lambda event source mappings poll SQS and invoke the existing consumer functions directly; there is no HTTP reconcile call and no application long-poll loop. Do not expose SQS or scheduled event dispatch through HTTP request bodies; select event shape at the trusted Lambda invocation boundary. Use partial-batch responses so only failed records retry; process independently and deduplicate by durable operation/revision, not SQS message ID. Set visibility timeout to at least six times function timeout plus batch window, validated against worst-case processing. Retention, retry count, batch size, concurrency, alarm thresholds and replay cadence are explicit bounded deployment configuration; limit SQS maximum concurrency below each shared function's reserved concurrency, retaining configured headroom for HTTP and bounded replay; shared functions still have shared cold starts/failure/concurrency impact. Encrypted queues/DLQs and scoped IAM remain required.

## Delayed reconciliation and retries

Creating a Checkout intent commits durable reconciliation work before any best-effort queue send. Persist next_attempt_at and bounded attempt/deadline fields. Initial fallback check uses configurable delay up to 900 seconds; five minutes is an example, not a payment deadline. A work-stream Pipe may wake the consumer early; the consumer checks due time and re-enqueues with per-message DelaySeconds, then acknowledges only after a durable due record and successful send. Replays/duplicates are fenced and do not duplicate payment effects.

On receipt, billing first checks committed order state: confirmed/terminal work is a no-op; otherwise only billing calls Stripe and reduces the authoritative result. Payment still pending is a successful observation, not a poison message: persist a later check and enqueue another bounded delayed message. Do not hold Lambda open, sleep or use visibility timeout as the payment-poll schedule. The consumer needs scoped SendMessage for its own retry queue as well as consume/delete permissions. Transient processing failures use SQS retry; exhausted failures reach a DLQ with alarms and explicit redrive after diagnosis. DLQ retention never silently removes the durable business work.

Longer waits persist the true due time and use repeated delays capped at 900 seconds, with scheduled replay as a safety net. A retry limit exposes pending-repair/error; it does not revoke paid state, assume unpaid, charge again or extend OAuth expiry. Only atomic claim/revision guards decide whether a delayed duplicate should act.

## Outbox delivery and missed-message recovery

SQS cannot recover a job never enqueued. Commit billing entitlement/outbox and access work atomically with their state changes; managed stream Pipes deliver hints, but stream retention/delivery can still fail. Preserve durable records and independent replay checkpoints beyond the configured recovery horizon. Mark business work complete only after its effect/transition is committed, never merely after SendMessage.

Retain bounded EventBridge schedules targeting the SAME access and billing functions with an explicit replay event kind. They query due work/expiry/outbox recovery indexes, re-read base records, re-enqueue missing due jobs and recover expired leases with overlap/lookback for eventual index visibility. This retains scheduled recovery without a dedicated recovery Lambda. Do not remove these schedules merely because queues exist. Pipe/DLQ failures alert and can be replayed from durable records; never depend solely on streams surviving their retention window.

Access replay never queries Stripe directly: billing's durable payment work and reconciliation consumer own missing-webhook checks. On browser resumption, coordinator may still invoke the billing native reconcileOrder operation for a bounded own-order check. Webhooks and reconciliation use the same fenced reducer. Late payment and closed browser behavior follow existing contracts.

## Acceptance

Test four-function IaC inventory, per-function roles and the intentionally shared access role, stream-to-queue transforms, no secrets, duplicate/out-of-order queue delivery, visibility/partial-batch handling, delayed pending checks, no-op after webhook confirmation, enqueue-after-commit crashes, lost streams, expired leases, scheduled replay on existing aliases, DLQ/redrive and compatible releases. Shared native/HTTP/SQS/schedule dispatch must reject unknown event shapes. Local fixtures and template checks are distinct from live AWS delivery evidence.
