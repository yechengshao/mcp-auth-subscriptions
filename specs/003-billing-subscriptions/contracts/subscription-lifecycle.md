# Contract: Subscription Lifecycle and Entitlement Reduction

**Status**: Planned reducer and acceptance cases; no live policy/provider validation. Eligibility policy is authoritative in [spec FR-007](../spec.md#functional-requirements), current-read/consumer behavior in [entitlements](entitlements.md), and transactional writes/leases in [storage operations](storage-operations.md). This contract maps verified provider observations into those interfaces, not a second policy source.

## Provider observation to projection

| Verified observation | Projection/reducer action | Purchase/login consequence |
|---|---|---|
| Checkout created or browser returned | Keep own order pending until authoritative payment checks; publish no paid grant from navigation | Show progress; no premature code/token |
| Active subscription with verified paid service interval and approved own plan/account | Set allowed under FR-007, plan and valid_until to the verified paid-through bound; commit changed revision/outbox | Access can complete only with its ready usage binding |
| Renewal payment confirmed for the same owned subscription | Extend paid-through only to the verified covered interval and reduce current provider status | Existing refresh deadline is not extended by rotation; access renewal rules remain authoritative |
| Renewal merely scheduled or invoice unpaid/open | Do not extend paid-through from the future provider period alone | Existing valid paid eligibility follows FR-007; past-due status is ineligible under no-grace policy |
| Cancel at period end while still active/paid | Record scheduled cancellation without shortening verified paid-through | No renewal; eligible access/refresh continues through paid expiry |
| Subscription immediately cancelled/revoked or provider status no longer eligible | Commit denied projection and changed revision/outbox | Next issuance/refresh/management denies; issued JWTs follow access's one-hour bound |
| Trialing, incomplete, incomplete_expired, unpaid, paused or past_due | Reduce to ineligible under FR-007; do not invent grace | Purchase/recovery may continue through bounded enrollment; no paid login |
| Paid-through passed with stale allowed=true still stored | Consumers evaluate valid_until against current time and deny immediately | No wait for webhook, worker or TTL cleanup |
| Verified payment received after OAuth/browser expiry | Commit billing normally without reviving access transaction | Fresh authorization reuses subscription; no duplicate purchase |
| Unknown plan/status, wrong account/environment/customer or contradictory ownership | Fail closed; retain sanitized repair/reconciliation outcome, never choose a paid tier from client claims | No grant until trusted state is resolved |

Store normalized UTC instants; explicitly encode second-based epoch fields at API/DynamoDB boundaries and validate types/ranges to avoid millisecond confusion. An event's creation time is not a monotonic subscription version. Fetch current provider objects under the fenced reducer, check configured API version, and derive only the paid service interval belonging to the approved subscription/price. PaymentIntent success, Checkout completion or a zero-amount/open invoice alone cannot establish arbitrary paid coverage. Document supported proration/credit/plan-change cases in adapter fixtures before enabling them; unsupported ambiguous coverage remains pending/requires repair rather than extending access.

Duplicate or older notifications must not shorten/extend a trusted interval from stale event payloads; current authoritative provider state may legitimately reduce eligibility. Serialize all reducers through the physical contract; changed allowed/plan/validity/cancellation/revocation decisions receive a new revision and outbox notification. An unchanged observation records its durable event outcome without redundant business effects.

## Management and uncertain results

All own-account management operations recheck current-paid eligibility and ownership at invocation, including existing sessions/links. Default supported cancellation is scheduling end-of-period cancellation; removing that schedule before expiry must preserve provider revision/idempotency semantics. Immediate administrative eligibility revocation is a distinct trusted billing action, not an arbitrary browser-supplied flag; it does not imply an automatic refund. Financial refunds/dispute automation remain outside scope.

Hosted portal stays unavailable until its saved sessions can satisfy the same gates; a redirect-time check alone is insufficient. Guarded management invokes billing through access with CSRF/session checks. Plan-change and payment-method/invoice management actions must be explicitly allowlisted and tested before exposure, never enabled as an unrestricted portal fallback. A browser-supplied new price or subscription/customer identifier cannot bypass server ownership/catalog checks.

Unknown Stripe outcomes return pending/retryable state and persist recovery intent; never report a confirmed cancellation or successful payment from a timeout. Verified webhooks and bounded reconciliation converge through the same reducer. An account with multiple conflicting candidate subscriptions must not trigger another purchase or arbitrary tier selection; hold conflict for reconciliation, preserving paid records.

## Acceptance matrix

B003 covers every observation above, immediately-before/at/after paid expiry, scheduled cancellation, unpaid renewal period advancement, mixed units and unsupported status/coverage. B005/B006/B007 cover concurrent duplicate effects, webhook ordering, provider-read failures and authoritative cancellation after earlier payment. B008/B012 cover delayed payment with closed browser, missed webhook recovery, changed plan/binding, rejected refresh after revocation and acceptance of a previously issued access token only within its existing expiration. B009 covers saved portal links, no management for ineligible users, CSRF/ownership and uncertain cancellation recovery. No fixture establishes live Stripe or host compatibility.
