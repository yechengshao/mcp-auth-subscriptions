# Contract: Billing Storage and Internal Operations

**Status**: Planned physical v1 interface for access planning; no tables/functions are deployed. Names/ARNs are outputs, never guessed. Deploy separate tables per environment/account. All keys include the configured environment even with isolated tables.

## Tables and keys

Use `PK`/`SK` strings. `identity_key` is SHA-256 of the unambiguous UTF-8 JSON array `[identity_issuer, identity_subject]`; preserve the verified tuple in owned records and reject mismatches. Environment is a fixed validated deployment value, not a browser field.

| Table / record | PK | SK | Required data |
|---|---|---|---|
| BillingState customer | `ENV#<env>#IDENTITY#<identity_key>` | `CUSTOMER` | Verified tuple, Stripe account/customer, revision, schema_version |
| BillingState subscription | Same identity partition | `SUB#<subscription_id>` | Own customer/order, plan_id, catalog_version and purchased usage mapping snapshot, provider status, paid_through, cancel/revoke state, revision |
| BillingState order | Same identity partition | `ORDER#<order_id>` | Immutable identity/environment/catalog-version/price/usage-mapping snapshot, intent, state/revision, Checkout/payment linkage, durable operation outcome |
| BillingState own work/lease | Same identity partition | `WORK#<operation_id>` / `LEASE` | Due time, owner, fence, expiry, attempts, outcome/error class |
| BillingState provider lookup | `ENV#<env>#STRIPE#<account>#<object_type>#<object_id>` | `OWNER` | Verified owning identity/order, conditionally unique mapping |
| BillingState event ledger | `ENV#<env>#EVENT#<account>#<event_id>` | `EVENT` | Minimal trusted event identifiers, processing state/lease/fence, committed revision, digest; no full provider payload |
| BillingEntitlements | `ENV#<env>#IDENTITY#<identity_key>` | `ENTITLEMENT` | Logical entitlement fields from entitlements contract, schema_version=1 |
| BillingActivationOutbox | `ENV#<env>#IDENTITY#<identity_key>` | `REV#<zero-padded-revision>` | notification_id, own order ref, verified tuple, decision revision/status, created_at, schema_version=1; no tokens/keys/payment secrets |

Storage outputs expose table ARNs/names and exact entitlement key/schema; no key/token/customer values. Access receives scoped entitlement GetItem and exact billing operation invocation, not billing event/outbox stream access. Billing alone writes billing tables and reads its durable decision/reconciliation history; MCP/authorizer receive no grants.

## Indexes and recovery

BillingActivationOutbox retains atomic decision history by identity/revision. No stream/Pipe/activation queue or access recovery index is required for that table; access reads the current entitlement instead of replaying history. BillingState reconciliation work retains its stream and due-work index for billing-only SQS/replay.

BillingState GSI `DueWork` has environment/shard partition and `next_attempt_at#operation_id` sort for explicit work records. Consistently re-read and conditionally claim work. Pages/attempts/deadlines/lookback/retention are explicit deployment config with validation; absent budgets fail startup, not unbounded scans. Retention must exceed the supported recovery horizon; cleanup requires verified consumer progress, never DynamoDB TTL alone. Retain event/order/provider-effect idempotency evidence so expired Stripe idempotency windows cannot recreate charges.

## Native operation envelope

Only selected access coordinator roles may invoke the exact billing alias. These trusted native Lambda events bypass Express and have `{schema_version:1, operation, environment, correlation_id, idempotency_key, identity:{issuer,subject}, continuation_ref?, input}`. Access derives identity from verified server-side state; IAM callers cannot be broadened to arbitrary clients. Binding/expiry validation of the enrollment session stays in access; billing checks own records, identity tuple, environment and per-operation eligibility independently.

| Operation | Input | Result / scope |
|---|---|---|
| `listPlans` | none | Approved nonsecret plan display/catalog version; verified purchase continuation |
| `createCheckout` | approved plan_id, purchase intent | Own order, persisted reconciliation intent and delayed billing check, then approved transient Checkout URL, or existing eligibility/pending outcome; no arbitrary price/redirect/customer |
| `getOrder` | order_id | Own sanitized state and activation reference; another identity receives no disclosure |
| `reconcileOrder` | order_id | One bounded provider reconciliation then committed/pending/retryable outcome; no wait loop |
| `manageSubscription` | explicit allowed action + own subscription reference | Current-paid/ownership-gated management; cancellation of renewal versus immediate revocation remains distinct |
| `openPortal` | own subscription reference | Disabled until hosted-session enforcement proves FR-009; otherwise use guarded management |

Results carry schema_version, correlation_id and a discriminated outcome `ok|pending|denied|retryable_unavailable|conflict|invalid_request`, with sanitized state/revision and bounded retry hint where appropriate. Native responses are not HTTP status codes. Access maps them to its browser protocol without leaking Stripe IDs or trusted identity. Provider reconciliation is billing-only; webhook is a separate raw-body HTTP operation.

## Integrity, concurrency and uncertain effects

Validate webhook signature/account/environment before mutation; event payload status is a notification, not ordering authority. Resolve own customer/order mapping, acquire a per-identity fenced lease, retrieve authoritative Stripe state and reduce against current revision. If first linkage is not yet durable, return retryable and recover; never infer ownership from email. Every DynamoDB commit condition-checks lease owner/fence and previous revision, so stale workers cannot publish; all mutation paths use this reducer/serialization.

Persist effect intent before Stripe calls and use stable per-operation Stripe idempotency keys. Crash/timeout after a possible provider effect enters uncertain state; inspect persisted/provider linkage before any retry. Beyond Stripe's deduplication window, do not blindly recreate Checkout/customer/payment effects: retain pending repair/reconciliation when absence cannot be proven. Conditional mappings prevent duplicate customer ownership; durable own intent and eligible/pending checks prevent duplicate purchase.

Commit the event outcome, own subscription/order summary, incremented entitlement revision and inserted outbox record in one TransactWriteItems, conditioned on current schema/revision/fence. Duplicate committed events acknowledge without another effect; partial/uncommitted failures remain retryable. HTTP 2xx means durably committed or already committed; invalid signatures fail before writes. Bound work to configured invocation budgets; expired leases are recoverable and unknown state cannot grant access.

Eligibility is defined only in spec FR-007 and the logical entitlement contract; physical records do not redefine policy. Renewal cannot blindly extend paid_through from an unpaid invoice. Cancellation/revocation and paid validity changes advance the projection revision and publish an outbox event. Access checks current projection at login/issuance/refresh, not in the token-only authorizer.

## Queue and replay interface

The [background delivery contract](../../002-authentication-api-access/contracts/background-delivery.md) owns message v1, delays and queue failure handling. BillingState uses NEW_IMAGE streams; its billing-owned Pipe filters reconciliation work inserts/updates and transforms only reference fields to BillingReconcileQueue. Set a work kind so provider/event/customer records cannot route as jobs. Missing due-time or schema is invalid. Before/alongside Checkout effects, persist own reconciliation work; consumer reads due time and schedules bounded delayed checks.

Billing's handler accepts separate HTTP webhook, trusted native operation, SQS record-batch and scheduled replay event shapes; reject ambiguity. SQS consumers do not require a browser continuation: resolve trusted identity/order from persisted work under queue IAM. Existing-function replay re-enqueues due records and recovers delivery gaps/leases. Billing background resources own this queue/Pipe/mapping/schedule and no access-state grants; access deploys no activation transport. Billing replay checkpoint ownership remains billing-only; access has no queue consumer/checkpoint.

Component IaC and handlers must implement the shared [CloudWatch/X-Ray contract](../../002-authentication-api-access/contracts/observability.md), including finite log retention, credential redaction, telemetry IAM, dashboards/alarms and separately validated live delivery.

Catalog source/schema, immutable order/entitlement mapping snapshots and cache/update rules follow the shared [plan catalog](plan-catalog.md).
