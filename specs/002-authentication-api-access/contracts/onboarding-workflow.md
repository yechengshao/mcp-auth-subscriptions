# Contract: Node.js Onboarding and Recovery

**Status**: Node.js/Express on AWS Lambda with DynamoDB persistence; implementation pending. No Step Functions resources or permissions. [Client flow](client-onboarding.md) · [Tokens/authorizer](authorization.md) · [Billing handoff](../../003-billing-subscriptions/contracts/checkout-onboarding.md)

## Flow and ownership

`authorization_pending → identity_verified → checkout_pending → payment_pending → activation_pending → code_ready → code_redeemed`

Eligible subscribers skip checkout. Cognito verifies identity; billing verifies Stripe and owns entitlement writes. Express routes handle authorization, login callbacks, browser status/resume, code/token exchange and billing HTTP ingress. The access Lambda consumes activation/provisioning SQS jobs and replays due work; billing consumes its own reconciliation queue. Access HTTP/background handlers share transition modules, one function and one role; authorizer and billing roles remain separate. MCP and the read-only authorizer have no orchestration responsibility.

Each request loads durable state, validates its trigger, performs bounded work, saves progress and returns promptly. Human/payment delays are persisted states between invocations. No open HTTP wait, process-local session/queue, detached promise or timer carries required work beyond a Lambda invocation. Browser status reads and scoped resume requests can recover progress; autonomous recovery must also work with the browser closed.

## Durable state and transitions

Access transactions record an opaque ID, registered client/redirect/resource/PKCE binding, verified identity, own-order reference, phase, monotonic revision, schema version, absolute expiry, attempts, next-attempt time and sanitized release/error metadata. Sensitive session/code/grant fields follow the client/token contracts. Physical keys, due-work indexes and limits are finalized in T014/T022.

All transitions use conditional writes against expected phase/revision, identity/order and unexpired state. Terminal cancelled/expired/redeemed states cannot reopen. Atomically commit required access work/outbox records with the transition that creates them; a crash after a state change must not lose its next action. External effects use stable operation/idempotency references and durable outcomes. Recover uncertain responses by inspecting authoritative provider/binding state before retrying; there is no exactly-once invocation assumption.

Workers claim bounded leases with owner/fencing revisions. Every completion checks the current lease and transaction/entitlement revision; stale workers cannot publish readiness or overwrite newer results. Recheck entitlement before and after native-key updates and reconcile any stale external association. A lease cannot make an external API call atomic with DynamoDB, so uncertain provider effects need explicit recovery tests.

Routes and caller/response boundaries follow the [endpoint contract](endpoints.md); authorization starts a transaction, resume continues it, and both share completion guards.

## Triggers and delivery

The [background delivery contract](background-delivery.md) defines four functions, queues, managed Pipes, delays, IAM and scheduled replay on existing consumers.

1. `/authorize` validates the complete client request, durably creates a bounded transaction and returns a Cognito redirect. The validated Cognito callback conditionally binds identity and advances from current entitlement; repeated or concurrent callbacks cannot create extra grants/orders.
2. Billing verifies the raw Stripe body and commits order/entitlement plus its durable activation outbox before acknowledging the webhook. A managed Pipe forwards scoped outbox references to activation SQS; the access Lambda background handler consumes these as hints to re-read authority, correlate immutable identity/own order and advance matching live transactions. Browser return parameters never establish payment.
3. Access-work streams route through managed Pipes to activation SQS and its existing access Lambda consumer. Use partial-batch failures, bounded retries/visibility and DLQs with alerts. Deduplicate by event/operation and current revision, not arrival order. Early notifications remain recoverable: after linking identity/order, re-read current entitlement and durable outstanding work.
4. An EventBridge replay schedule invokes the same access Lambda that queries paginated, bounded due-work/expiry candidates, including expired leases and failed delivery. Index results are scheduling hints; consistently re-read base records and claim conditionally. Durable outbox replay covers missed notifications/stream-retention gaps; billing queue checks and its own existing-function replay cover missing webhooks. Only billing queries Stripe.
5. Retry native-key propagation and transient failures using persisted next-attempt times, capped attempts and backoff with jitter. Return after saving progress; do not sleep inside handlers. Exhausted retries expose an activation error and retain repairable records. Replays use the same trusted transition checks and never extend the original OAuth deadline.

Due-work partitions/indexes, batch/page budgets, lease lengths, schedules, retention, retry limits and failure destinations are explicit planning inputs. A periodic sweep must eventually revisit outstanding durable records even when stream delivery is lost; GSI visibility delays affect scheduling latency, never authorization.

## Completion, expiry and releases

A transition may mark `code_ready` only after current paid entitlement and matching ready usage binding. The authenticated browser resume endpoint rechecks authority, then atomically issues a one-use code and redirects with original state/issuer; workers do not redirect browsers or emit credentials. `/token` independently checks current authority. Retried/concurrent resume and redemption cannot create additional grants.

Keep the 30-minute absolute continuation, 60-second code, access/refresh lifetimes in the [authorization contract](authorization.md#denial-and-revocation). Every operation checks expiry independently of cleanup; DynamoDB TTL is housekeeping. Cancellation/expiry stops transaction-specific work without changing paid records. Late payment commits normally and fresh authorization reuses the subscription.

Log only opaque correlation, phase/revision, release and sanitized failure categories; exclude cookies, OAuth state/codes/verifiers, bearer/refresh tokens, native keys and full provider payloads. Coordinator owns sessions/signing and exact billing invocation; the access background handler manages scoped work/outbox reads, access transitions and native-key management; background code does not issue tokens and the access role cannot read Stripe secrets. No access role writes billing or holds Stripe credentials.

Record schema/config/handler release versions with durable work. New releases and rollback must support existing unexpired records; incompatible records fail closed with a repair path. Retain identity/billing/grant/work data across deployments and scoped cleanup; cancellation applies only to owned transactions.

## Acceptance and sources

Test cold starts, browser closure, concurrent callbacks/resume, duplicate/reordered/early events, crashes before/after commits and provider calls, lease expiry/stale completion, partial batches, stream gaps, bounded retries, cancellation/expiry, late-paid reconnect, compatible upgrades/rollback and secret-free logs. Local fixtures do not prove live Cognito/Stripe/stream/schedule/host behavior; live checks remain not_run.

[AWS Lambda DynamoDB delivery](https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html) documents duplicate delivery; [DynamoDB conditional writes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html) support transition guards. [Lambda lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html) explains invocation/environment boundaries. The state model, retry policy and component split above are project design decisions.
