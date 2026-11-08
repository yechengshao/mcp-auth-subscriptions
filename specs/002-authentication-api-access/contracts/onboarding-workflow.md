# Contract: Node.js Onboarding and Recovery

**Status**: Node.js/Express on AWS Lambda with DynamoDB persistence; implementation pending. No Step Functions resources or permissions. [Client flow](client-onboarding.md) · [Tokens/authorizer](authorization.md) · [Billing handoff](../../003-billing-subscriptions/contracts/checkout-onboarding.md)

## Flow and ownership

`authorization_pending → identity_verified → checkout_pending → payment_pending → activation_pending → code_ready → code_issued → code_redeemed`

Eligible subscribers skip checkout. Cognito verifies identity; billing verifies Stripe and owns entitlement writes. Access Express handles authorization, login callbacks, browser status/resume and code/token exchange. Bounded status/resume or fresh-login requests prepare native usage bindings using persisted idempotency/revision/lease guards. Billing ingress routes the Stripe webhook directly to billing. There is no access queue, stream consumer or scheduled worker; payment reconciliation continues in billing without a browser, while binding activation waits for the next access request.

Each request loads durable state, validates its trigger, performs bounded work, saves progress and returns promptly. Human/payment/failed-or-uncertain-setup delays remain persisted pending state; no detached promise, timer or process-local session carries required work after return. A closed page pauses access provisioning without losing payment. Fresh authorization reuses entitlement after the original continuation expires.

## Durable state and transitions

Access transactions record an opaque ID, registered client/redirect/resource/PKCE binding, verified identity, own-order reference, phase, monotonic revision, schema version, absolute expiry, attempts, next-attempt time and sanitized release/error metadata. Sensitive session/code/grant fields follow the client/token contracts. Physical keys, record fields, retention and transaction rules follow the [access storage contract](access-storage.md); T014/T022 validate their schemas.

All transitions use conditional writes against expected phase/revision, identity/order and unexpired state. Terminal cancelled/expired/redeemed states cannot reopen. Persist the required next provisioning action with its transition; a crash must leave recoverable state for the next browser/reconnect request, not depend on enqueueing. External effects use stable operation/idempotency references and durable outcomes. Recover uncertain responses by inspecting authoritative provider/binding state before retrying; there is no exactly-once invocation assumption.

Provisioning requests claim bounded leases with owner/fencing revisions. Every completion checks the current lease and transaction/entitlement revision; stale requests cannot publish readiness or overwrite newer results. Recheck entitlement before and after native-key updates; use access-storage external-generation exclusion before conflicting mutations, because a local fence cannot stop a delayed AWS call. A lease cannot make an external API call atomic with DynamoDB, so uncertain provider effects need explicit recovery tests.

Routes and caller/response boundaries follow the [endpoint contract](endpoints.md); authorization starts a transaction, resume continues it, and both share completion guards.

## Triggers and retry

The [delivery contract](background-delivery.md) owns the four-function inventory and billing-only SQS/replay transport.

1. `/authorize` saves a bounded transaction and redirects to Cognito; the validated callback binds identity and reads current entitlement.
2. Billing commits verified entitlement plus durable decision history; access learns the latest state by consistent reads, not activation notifications.
3. Browser status/resume requests advance eligible activation using bounded native-key operations and leases; duplicate/concurrent requests re-read current authority and cannot duplicate effects.
4. Pending activation stores next_attempt_at, bounded attempts and sanitized outcome; browser polling backs off and stops on ready/terminal/expired state, with no sleeps inside Lambda. Only a due request can retry; AWS call failures/timeouts return an activation error with retry/reconnect guidance immediately, retaining recoverable internal state; exhausted/permanent failures include support guidance.
5. Billing's delayed queue and scheduled replay handle missed payment webhooks, including when the browser is closed. Access may request a bounded own-order billing reconciliation but never queries Stripe.

On return/reconnect, reclaim expired provisioning leases conditionally, inspect uncertain external effects, and recheck entitlement around key changes. Cancellation/retry cannot extend the original OAuth deadline. No closed-browser access-completion guarantee is made.

Binding readiness follows the [REST configuration-success rule](rest-gateway.md#native-metering): successful AWS API response plus matching conditional persistence, no routine read-back/probe or propagation wait.

## Completion, expiry and releases

A transition may mark `code_ready` only after current paid entitlement and matching ready usage binding. The authenticated browser resume endpoint rechecks authority, then atomically issues a one-use code and redirects with original state/issuer; workers do not redirect browsers or emit credentials. `/token` independently checks current authority. Retried/concurrent resume and redemption cannot create additional grants.

Keep the 30-minute absolute continuation, 60-second code, access/refresh lifetimes in the [authorization contract](authorization.md#denial-and-revocation). Every operation checks expiry independently of cleanup; DynamoDB TTL is housekeeping. Cancellation/expiry stops transaction-specific work without changing paid records. Late payment commits normally and fresh authorization reuses the subscription.

Log only opaque correlation, phase/revision, release and sanitized failure categories; exclude cookies, OAuth state/codes/verifiers, bearer/refresh tokens, native keys and full provider payloads. Coordinator owns sessions/signing and exact billing invocation; bounded access HTTP provisioning manages binding transitions and native-key operations; the access role cannot read Stripe secrets. No access role writes billing or holds Stripe credentials.

Record schema/config/handler release versions with durable work. New releases and rollback must support existing unexpired records; incompatible records fail closed with a repair path. Retain identity/billing/grant/work data across deployments and scoped cleanup; cancellation applies only to owned transactions.

## Acceptance and sources

Test cold starts, browser closure, concurrent callbacks/resume, duplicate/reordered/early events, crashes before/after commits and provider calls, lease expiry/stale completion, partial batches, missed billing callbacks, request-driven retries, cancellation/expiry, late-paid reconnect, compatible upgrades/rollback and secret-free logs. Local fixtures do not prove live Cognito/Stripe/billing-queue/host behavior; live checks remain not_run.

[AWS Lambda DynamoDB delivery](https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html) documents duplicate delivery; [DynamoDB conditional writes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html) support transition guards. [Lambda lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html) explains invocation/environment boundaries. The state model, retry policy and component split above are project design decisions.
