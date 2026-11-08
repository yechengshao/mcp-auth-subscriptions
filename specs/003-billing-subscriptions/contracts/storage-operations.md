# Contract: Billing Storage and Internal Operations

**Status**: Planned physical v1 interface for access planning; no tables/functions are deployed. Names/ARNs are outputs, never guessed. Deploy exactly two billing tables per environment/account: BillingState and BillingEntitlements; AccessState is the third application table and belongs to access. All keys include the configured environment even with isolated tables.

## Tables and keys

Use `PK`/`SK` strings with server-owned entity_type/schema_version discriminators for every record group. `identity_key` is SHA-256 of the unambiguous UTF-8 JSON array `[identity_issuer, identity_subject]`; preserve the verified tuple in owned records and reject mismatches. Environment is a fixed validated deployment value, not a browser field.

| Table / record | PK | SK | Required data |
|---|---|---|---|
| BillingState customer | `ENV#<env>#IDENTITY#<identity_key>` | `CUSTOMER` | Verified tuple, Stripe account/customer, revision, schema_version |
| BillingState subscription | Same identity partition | `SUB#<application_subscription_id>` | Own customer/order, plan_id, catalog_version and purchased usage mapping snapshot, verified payment/term status, term_start, paid_through, revoke state, revision |
| BillingState order | Same identity partition | `ORDER#<order_id>` | Immutable identity/environment/plan/duration/service-term/catalog-version/price/usage-mapping snapshot, intent, state/revision, Checkout/payment linkage, durable operation outcome |
| BillingState upgrade quote | Same identity partition | `UPGRADEQUOTE#<quote_id>` | Immutable source subscription/term/revision, target catalog/tier/duration/mapping, full/credit/net amount/currency, quote_at/expires_at, state/revision and quote digest |
| BillingState credit reservation | Same identity partition | `UPGRADERESERVATION#<application_subscription_id>` | Current source_term_id, source revision, quote/order/operation IDs, generation, state=held/consumed/released, terminal provider evidence; no TTL-based unlock |
| BillingState consumed-credit ledger | Same identity partition | `CREDIT#<source_term_id>` | Once-only consumption receipt with quote/order/payment IDs, credited amount/currency and new term_id; immutable, no TTL while paid records can be replayed |
| BillingState own work/lease | Same identity partition | `WORK#<operation_id>` / `LEASE` | Due time, owner, fence, expiry, attempts, outcome/error class |
| BillingState provider lookup | `ENV#<env>#STRIPE#<account>#<object_type>#<object_id>` | `OWNER` | Verified owning identity/order, conditionally unique mapping |
| BillingState event ledger | `ENV#<env>#EVENT#<account>#<event_id>` | `EVENT` | Minimal trusted event identifiers, processing state/lease/fence, committed revision, digest; no full provider payload |
| BillingEntitlements | `ENV#<env>#IDENTITY#<identity_key>` | `ENTITLEMENT` | Logical entitlement fields from entitlements contract, schema_version=1 |
| BillingState decision history | `ENV#<env>#IDENTITY#<identity_key>` | `HISTORY#<zero-padded-revision>` | notification_id, own order ref, verified tuple, decision revision/status, created_at, schema_version=1; no tokens/keys/payment secrets |

Storage outputs expose table ARNs/names and exact entitlement key/schema; no key/token/customer values. Access receives scoped entitlement GetItem/transaction ConditionCheckItem and exact billing operation invocation, not billing event/outbox stream access. Billing alone writes billing tables and reads its durable decision/reconciliation history; MCP/authorizer receive no grants.

## Indexes and recovery

Decision history is an immutable HISTORY record group inside BillingState; there is no separate BillingActivationOutbox table. Access reads BillingEntitlements rather than payment/history rows. BillingState uses its existing NEW_IMAGE stream for reconciliation work only: the Pipe requires INSERT plus entity_type=reconciliation_work and the WORK key namespace; history/customer/event/quote/credit inserts and all MODIFY/REMOVE events cannot enqueue jobs. Do not add a history-specific stream/Pipe/queue/index.

BillingState GSI `DueWork` has environment/shard partition and `next_attempt_at#operation_id` sort for explicit work records. Consistently re-read and conditionally claim work. Pages/attempts/deadlines/lookback/retention are explicit deployment config with validation; absent budgets fail startup, not unbounded scans. Retention must exceed the supported recovery horizon; cleanup requires verified consumer progress, never DynamoDB TTL alone. Retain event/order/provider-effect idempotency evidence so expired Stripe idempotency windows cannot recreate charges.

## Native operation envelope

Only selected access coordinator roles may invoke the exact billing alias. These trusted native Lambda events bypass Express and have `{schema_version:1, operation, environment, correlation_id, idempotency_key, identity:{issuer,subject}, continuation_ref?, input}`. Access derives identity from verified server-side state; IAM callers cannot be broadened to arbitrary clients. Binding/expiry validation of the enrollment session stays in access; billing checks own records, identity tuple, environment and per-operation eligibility independently.

| Operation | Input | Result / scope |
|---|---|---|
| `listPlans` | none | Approved nonsecret plan display/catalog version; verified purchase continuation |
| `createCheckout` | approved plan_id, duration_option_id, catalog_version and purchase intent | Own order, persisted reconciliation intent and delayed billing check, then approved transient Checkout URL, or existing eligibility/pending outcome; no arbitrary price/redirect/customer |
| `getOrder` | order_id | Own sanitized state and activation reference; another identity receives no disclosure |
| `reconcileOrder` | order_id | One bounded provider reconciliation then committed/pending/retryable outcome; no wait loop |
| `quoteUpgrade` / `confirmUpgrade` | Current source revision, target plan/duration/catalog version or accepted quote ID | Verified paid owner; immutable server quote and one-use credit reservation under plan-upgrade contract |
| `manageSubscription` | explicit allowed action + own application subscription reference | Current-paid/ownership-gated management; only self-service strictly higher-tier paid upgrades; downgrade/cancel/refund returns support_required without mutation; separate audited support/admin operations are not callable through browser management |
| `openPortal` | own subscription reference | Always support_required/feature_unavailable in this release; never create a portal session or invoke cancellation/refund APIs |

Results carry schema_version, correlation_id and outcome=`ok|pending|denied|retryable_unavailable|conflict|invalid_request|support_required`, plus allowlisted error_code, retryable, safe message and sanitized typed payload. Error codes are NOT additional outcome variants. Use conflict/catalog_changed for a stale offer, support_required/unsupported_credit_case for nonpositive credit, and support_required/financial_support_required for refund/cancel/downgrade/ambiguous financial requests. No result includes credential/provider payloads. Billing owns provider reconciliation; webhook is a separate raw-body HTTP operation.

For browser JSON operations map ok→200, pending→202 with retry hint, denied→403, invalid_request→400, conflict→409, retryable_unavailable→503 with Retry-After, support_required→409 with configured contact/reason and no automatic retry or mutation. The UI renders status/error_code rather than treating every 409 as a re-quote. Malformed/unknown outcome/code combinations fail schema validation. Native responses themselves are not HTTP envelopes. OAuth `/token` retains OAuth error/status rules and webhook retains signature/commit acknowledgment rules; successful top-level browser forms retain specified 303 redirects. Do not turn an OAuth invalid_grant into a billing support status.

## Integrity, concurrency and uncertain effects

Validate webhook signature/account/environment before mutation; event payload status is a notification, not ordering authority. Resolve own customer/order mapping, acquire a per-identity fenced lease, retrieve authoritative Stripe state and reduce against current revision. If first linkage is not yet durable, return retryable and recover; never infer ownership from email. Every DynamoDB commit condition-checks lease owner/fence and previous revision, so stale workers cannot publish; all mutation paths use this reducer/serialization.

Persist effect intent before Stripe calls and use stable per-operation Stripe idempotency keys. Crash/timeout after a possible provider effect enters uncertain state; inspect persisted/provider linkage before any retry. Beyond Stripe's deduplication window, do not blindly recreate Checkout/customer/payment effects: retain pending repair/reconciliation when absence cannot be proven. Conditional mappings prevent duplicate customer ownership; durable own intent and eligible/pending checks prevent duplicate purchase.

Commit the event outcome, own subscription/order summary, incremented entitlement revision and inserted outbox record in one TransactWriteItems, conditioned on current schema/revision/fence. Duplicate committed events acknowledge without another effect; partial/uncommitted failures remain retryable. HTTP 2xx means durably committed or already committed; invalid signatures fail before writes. Bound work to configured invocation budgets; expired leases are recoverable and unknown state cannot grant access.

Eligibility is defined only in spec FR-007 and the logical entitlement contract; physical records do not redefine policy. Renewal requires a fresh explicit paid-term Checkout under the manual-renewal contract; no unpaid invoice/recurring event can extend paid_through. Cancellation/revocation and paid validity changes advance the projection revision and publish an outbox event. Access checks current projection at login/issuance/refresh, not in the token-only authorizer.

## Upgrade quote and credit transactions

The subscription is a stable application aggregate with current term_id; every initial purchase/manual renewal/paid upgrade introduces a new unique term_id. Retain replaced terms in immutable decision history; never reuse a term ID. Quote creation stores a server-generated opaque quote_id and immutable financial/mapping snapshot with digest under a conditional absent key, binding identity/source term and version; the browser cannot supply snapshot amounts.

Confirming a valid positive quote uses one TransactWriteItems: condition-check current paid source subscription/term/revision and current entitlement, conditionally transition the quote offered→confirmed, reserve the stable subscription reservation row for that term/generation, and insert exactly one upgrade order and reconciliation work intent. Reservation is exclusive across quotes for the same subscription. A repeated identical operation reads/reuses the existing order; a competing quote receives conflict. No source entitlement changes at confirmation. Combine conditions with an item's update instead of condition-checking and updating the same item separately.

Stripe Checkout is an external effect after this commit, using stable upgrade operation identity. Record its session/payment linkage without changing the quote amount. Expiry of quote or local lease does not release a held reservation if Checkout/payment might still succeed; require a verified terminal-unpaid/cancelled provider outcome under fenced reconciliation before conditional release. A stale release cannot clear a newer reservation generation. No cleanup TTL releases financial credit.

Verified paid-upgrade commit is one bounded transaction on distinct keys: conditionally update source subscription aggregate from its snapshotted term/revision to the new term, insert consumed-credit ledger only if absent, mark the held reservation consumed for the same quote/order/generation, transition quote/order to applied, record event outcome, update entitlement with the purchased target snapshot/new revision, append immutable decision history and complete corresponding work. Conditions require exact identity, source term, expected revisions, verified owned amount/currency and payment identity. Duplicate committed payment reads the existing receipt/outcome, never consumes credit twice. Different paid events for an already superseded source become paid repair conflicts with support routing; no automated refund or overwrite.

B001/B007/B009 test exact record keys and all-or-nothing reserve/consume/release paths, two tabs confirming different quotes, duplicate webhook/reconcile, source change before payment, expired quote with still-payable Checkout, lost provider response and late payment. Financial support actions stay outside browser operations.

## Queue and replay interface

The [background delivery contract](../../002-authentication-api-access/contracts/background-delivery.md) owns message v1, delays and queue failure handling. BillingState uses NEW_IMAGE streams; its billing-owned Pipe filters only INSERT reconciliation-work records and transforms reference fields plus message_type=dispatch_hint/generation to BillingReconcileQueue. Set a work kind so provider/event/customer records cannot route as jobs. Missing due-time or schema is invalid. Before/alongside Checkout effects, persist own reconciliation work; all scheduling uses the generation-fenced common billing publisher defined by the delivery contract.

Billing's handler accepts separate HTTP webhook, trusted native operation, SQS record-batch and scheduled replay event shapes; reject ambiguity. SQS consumers do not require a browser continuation: resolve trusted identity/order from persisted work under queue IAM. Existing-function replay re-enqueues due records and recovers delivery gaps/leases. Billing background resources own this queue/Pipe/mapping/schedule and no access-state grants; access deploys no activation transport. Billing replay checkpoint ownership remains billing-only; access has no queue consumer/checkpoint.

Component IaC and handlers must implement the shared [CloudWatch/X-Ray contract](../../002-authentication-api-access/contracts/observability.md), including finite log retention, credential redaction, telemetry IAM, dashboards/alarms and separately validated live delivery.

Catalog source/schema, immutable order/entitlement mapping snapshots and cache/update rules follow the shared [plan catalog](plan-catalog.md).

Reconciliation work also stores generation/due_at, processing owner/fence/lease, dispatch status/owner/lease/attempts, expected_message_due_at, dispatch epoch and terminal outcome. MODIFY events are not Pipe inputs; duplicate hints/early run deliveries never blindly re-enqueue. B001/B008/B010/B013 enforce the shared publisher protocol and its bounded dispatch/replay configuration.

The consolidated inventory is AccessState (access-owned, selective TTL), BillingState (billing-owned payment/work/history), and BillingEntitlements (billing-owned current projection). Access receives no BillingState read/write/stream grants. Decision history, quote/reservation/credit rows remain distinct immutable/conditional items even though they share a table; transactions still use distinct keys. No automatic TTL deletes paid financial/history rows.
