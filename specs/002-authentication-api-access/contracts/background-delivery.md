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

Message v1 fields are schema_version, kind=reconcile_payment, message_type=dispatch_hint|run, generation, environment, durable_record_key, operation_id and correlation_id. Pipe emits only dispatch_hint; the common billing publisher emits delayed run messages. Billing consistently loads owned work, verifies order/revision/schema/environment and claims a fenced lease before effects. Queue messages are hints, never trusted payment/identity/price authority; no tokens/keys/provider payloads/secrets enter them. Pipe role gets scoped stream-read/SendMessage, billing gets scoped consume/delete/retry SendMessage, and queue policies restrict producers.

AWS polls SQS and invokes billing directly, not an HTTP endpoint or application long-poll loop. Use partial-batch responses and durable operation deduplication. Set visibility timeout to at least six times function timeout plus batch window; validate batch/concurrency/retention/retry/alarm budgets. Cap SQS concurrency below billing reserved concurrency to leave webhook/native-operation headroom. Billing alone dispatches HTTP/native/SQS/schedule event shapes; HTTP bodies cannot select native background execution. Access accepts HTTP events only; the separate authorizer accepts REQUEST events.

## Request-driven access activation

The access Lambda prepares usage bindings during bounded onboarding status/resume requests or a fresh login after identity verification. Re-read current entitlement and conditionally claim the persisted provisioning lease/revision before creating/reusing native keys or updating usage plans. If a failed/uncertain AWS operation or conditional commit leaves setup incomplete, persist pending state and next_attempt_at, return a sanitized activation error with retry/reconnect guidance for failed AWS calls, and let a later bounded request recover/retry. Successful AWS configuration responses plus current-revision conditional persistence mark the binding ready without another read/probe/propagation wait, under the REST gateway contract. No access work continues after the invocation returns; `/token` checks readiness but never waits through provisioning.

Concurrent requests and retries must not duplicate keys/associations or overwrite a newer entitlement revision. Resume recovers uncertain effects from native state before retrying. If the browser closes, access provisioning pauses until a valid resume/new authorization request. Billing webhooks and delayed payment checks continue independently; retain confirmed payment and reuse it without repurchase. Expired OAuth transactions cannot revive, and valid_until is checked in code before any TTL cleanup.

## Delayed reconciliation and retries

Creating a Checkout intent persists work generation=1 and due_at before calling a COMMON billing publisher; Checkout, the INSERT-only work-stream Pipe consumer and scheduled replay all use that same publisher. The Pipe filters eventName=INSERT plus reconciliation-work kind, never MODIFY/REMOVE. Its immediate dispatch_hint is a wakeup, not a payment check or permission to forward every duplicate. Work updates therefore cannot recursively create queue hints. Pipe transforms retain explicit message_type/generation; consumer never infers them from browser data.

For each generation, the publisher conditionally claims dispatch_owner/lease, checks status, due_at and confirmed send evidence, then sends one delayed run message with DelaySeconds=min(max(due_at-now,0),900). Persist dispatch status sent with expected_message_due_at only after SendMessage success. Concurrent publisher calls with an unexpired claim or unexpired sent/delivery lease do nothing; duplicate hints are acknowledged without re-enqueue. Failed/unknown sends retain durable evidence, capped dispatch_attempts/backoff and at most one publisher claimant. A crash after send before persistence can cause a bounded duplicate on recovery, not an exactly-once claim. Config requires dispatch_max_attempts and delivery_replay_grace; exhaustion alerts/retains repairable work rather than an endless fanout loop.

Messages received as run first load work. Older generations or completed work acknowledge without actions. Future/invalid generations fail schema/state checks; a current generation not yet due acknowledges the early hint/run WITHOUT re-enqueue. If due_at is more than 900 seconds away, the first scheduled wake may simply be early; billing scheduled replay, not each duplicate consumer, schedules the remaining bounded wait through the common publisher once its expected delivery/grace window closes. Clock/early delivery is not a payment-poll error. Run consumers never directly forward an early copy into another copy.

A due run conditionally claims the processing lease and rechecks the committed order: confirmed/terminal order completes work as a no-op; otherwise billing checks Stripe. Pending payment is a successful observation. Commit next_attempt_at/due_at and generation+1, reset that generation's dispatch state, then call the common publisher once. The work-row MODIFY does not trigger a Pipe hint. Real processing failures return partial-batch failure and use SQS visibility retry for the same generation; visibility is not the normal payment schedule. Reconciliation attempts/deadline and dispatch attempts are separate bounded counters.

Replay inspects only overdue incomplete generations with expired processing/dispatch/delivery leases. Confirmed successful sends do not cause publishing on every sweep; wait until expected delivery plus configured grace/processing/visibility allowance, then acquire a single fenced replay-dispatch epoch. DLQ state must be diagnosed/redriven, not continually republished behind the DLQ. Generation checks prevent obsolete redrives from acting. Transport can still duplicate deliveries, but the application does not recursively multiply hints or delayed successors. Keep retained work and alarms for exhausted deliveries.

Initial delay is configurable up to 900 seconds (five minutes is an example, not a deadline). No sleep or open Lambda while waiting; billing alone polls actual payment. Transient failures retry to a DLQ; no retry can charge for another term, revoke paid state, extend OAuth expiry or repeat a consumed upgrade credit. Test immediate Pipe hint + Checkout publisher race, duplicate early runs, pending-generation update, ambiguous SendMessage, replay overlap and old-generation redrive.

## Billing work delivery and missed-message recovery

SQS cannot recover a job never enqueued. Billing commits reconciliation work with its state changes before best-effort sends; the INSERT-only billing work-stream Pipe delivers dispatch hints. Keep durable payment-work records and due-work indexes beyond the configured recovery horizon. Mark work complete after the business result commits, never merely after SendMessage. A bounded EventBridge replay schedule targets the SAME billing Lambda, re-reads due records, re-enqueues missing jobs and recovers expired billing leases. No access replay schedule or separate recovery function is needed.

Retain billing's entitlement/decision outbox as durable history alongside atomic commits, not an activation transport to access. Access reads current entitlement on every onboarding/issuance/refresh decision and does not need to consume every billing event. Pipe/DLQ failures alert and can be replayed from billing work even beyond stream retention. A browser may request a bounded own-order reconciliation through the existing billing native operation; only billing queries Stripe.

## Acceptance

Test four-function inventory and absence of access queue/Pipe/DLQ/mapping/schedule/IAM; HTTP provisioning races/pending/backoff/lease recovery, closed-browser pause and paid reconnect; billing stream-to-queue transforms, partial batches, delays, confirmed-order no-op, enqueue-after-commit crashes, lost streams, existing-billing replay, DLQ/redrive and compatible releases. Billing mixed-event dispatch must reject unknown shapes and access must not expose native queue handlers. Local fixtures and template checks are distinct from live AWS delivery evidence.
