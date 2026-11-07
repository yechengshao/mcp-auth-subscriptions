# Contract: Four Lambdas and Durable SQS Delivery

**Status**: Planned, not implemented. This contract owns function boundaries and background transport; onboarding owns transition guards and billing owns provider authority. No infrastructure is provisioned by this revision.

## Function inventory

| Function | Spec | Responsibility |
|---|---|---|
| MCP | 001 | Market-analysis MCP transport/tools; no identity/billing permissions |
| Access | 002 | Express discovery/OAuth/session/token/status/resume plus bounded request-driven usage-key provisioning |
| Authorizer | 002 | Direct REQUEST JWT validation and signed usageIdentifierKey response; no datastore access |
| Billing | 003 | HTTP Stripe webhook, trusted native operations, SQS payment reconciliation and scheduled billing-work replay |

Access uses one HTTP function/role for OAuth, signing and request-driven provisioning. No separate access worker/recovery function exists. Its role combines exact signing-key read, access-state/binding writes, entitlement reads, selected billing invocation and native usage-key/plan management. It has no SQS/stream/scheduled-replay, Stripe-secret or billing-write permissions. Authorizer, billing and MCP retain distinct roles. Token routes alone issue credentials after current authority checks; status/resume may perform bounded provisioning and return pending rather than waiting.

## Billing queue and managed routing

Use one Standard work queue, `BillingReconcileQueue`, with its own dead-letter queue. Billing background IaC owns the queue/DLQ, billing Lambda SQS mapping and EventBridge Pipe from billing reconciliation-work stream records. The Pipe filters/transforms references only; no routing Lambda is added. Provision storage before the Pipe and inject outputs without reverse stack imports. There is no access activation queue, access queue DLQ, access Pipe, access SQS mapping or access scheduled replay.

Message v1 fields are schema_version, kind=reconcile_payment, environment, durable_record_key, operation_id and correlation_id. Billing consistently loads owned work, verifies order/revision/schema/environment and claims a fenced lease before effects. Queue messages are hints, never trusted payment/identity/price authority; no tokens/keys/provider payloads/secrets enter them. Pipe role gets scoped stream-read/SendMessage, billing gets scoped consume/delete/retry SendMessage, and queue policies restrict producers.

AWS polls SQS and invokes billing directly, not an HTTP endpoint or application long-poll loop. Use partial-batch responses and durable operation deduplication. Set visibility timeout to at least six times function timeout plus batch window; validate batch/concurrency/retention/retry/alarm budgets. Cap SQS concurrency below billing reserved concurrency to leave webhook/native-operation headroom. Billing alone dispatches HTTP/native/SQS/schedule event shapes; HTTP bodies cannot select native background execution. Access accepts HTTP events only; the separate authorizer accepts REQUEST events.

## Request-driven access activation

The access Lambda prepares usage bindings during bounded onboarding status/resume requests or a fresh login after identity verification. Re-read current entitlement and conditionally claim the persisted provisioning lease/revision before creating/reusing native keys or updating usage plans. If propagation or transient failures leave activation incomplete, persist pending state and next_attempt_at, return promptly with a retry hint, and let bounded browser polling/reconnect retry. No access work continues after the invocation returns; `/token` checks readiness but never waits through provisioning.

Concurrent requests and retries must not duplicate keys/associations or overwrite a newer entitlement revision. Resume recovers uncertain effects from native state before retrying. If the browser closes, access provisioning pauses until a valid resume/new authorization request. Billing webhooks and delayed payment checks continue independently; retain confirmed payment and reuse it without repurchase. Expired OAuth transactions cannot revive, and valid_until is checked in code before any TTL cleanup.

## Delayed reconciliation and retries

Creating a Checkout intent commits durable reconciliation work before any best-effort queue send. Persist next_attempt_at and bounded attempt/deadline fields. Initial fallback check uses configurable delay up to 900 seconds; five minutes is an example, not a payment deadline. A work-stream Pipe may wake the consumer early; the consumer checks due time and re-enqueues with per-message DelaySeconds, then acknowledges only after a durable due record and successful send. Replays/duplicates are fenced and do not duplicate payment effects.

On receipt, billing first checks committed order state: confirmed/terminal work is a no-op; otherwise only billing calls Stripe and reduces the authoritative result. Payment still pending is a successful observation, not a poison message: persist a later check and enqueue another bounded delayed message. Do not hold Lambda open, sleep or use visibility timeout as the payment-poll schedule. The consumer needs scoped SendMessage for its own retry queue as well as consume/delete permissions. Transient processing failures use SQS retry; exhausted failures reach a DLQ with alarms and explicit redrive after diagnosis. DLQ retention never silently removes the durable business work.

Longer waits persist the true due time and use repeated delays capped at 900 seconds, with scheduled replay as a safety net. A retry limit exposes pending-repair/error; it does not revoke paid state, assume unpaid, charge again or extend OAuth expiry. Only atomic claim/revision guards decide whether a delayed duplicate should act.

## Billing work delivery and missed-message recovery

SQS cannot recover a job never enqueued. Billing commits reconciliation work with its state changes before best-effort sends; the managed billing work-stream Pipe delivers references. Keep durable payment-work records and due-work indexes beyond the configured recovery horizon. Mark work complete after the business result commits, never merely after SendMessage. A bounded EventBridge replay schedule targets the SAME billing Lambda, re-reads due records, re-enqueues missing jobs and recovers expired billing leases. No access replay schedule or separate recovery function is needed.

Retain billing's entitlement/decision outbox as durable history alongside atomic commits, not an activation transport to access. Access reads current entitlement on every onboarding/issuance/refresh decision and does not need to consume every billing event. Pipe/DLQ failures alert and can be replayed from billing work even beyond stream retention. A browser may request a bounded own-order reconciliation through the existing billing native operation; only billing queries Stripe.

## Acceptance

Test four-function inventory and absence of access queue/Pipe/DLQ/mapping/schedule/IAM; HTTP provisioning races/pending/backoff/lease recovery, closed-browser pause and paid reconnect; billing stream-to-queue transforms, partial batches, delays, confirmed-order no-op, enqueue-after-commit crashes, lost streams, existing-billing replay, DLQ/redrive and compatible releases. Billing mixed-event dispatch must reject unknown shapes and access must not expose native queue handlers. Local fixtures and template checks are distinct from live AWS delivery evidence.
