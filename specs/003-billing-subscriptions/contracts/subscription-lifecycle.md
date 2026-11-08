# Contract: Subscription Lifecycle and Entitlement Reduction

**Status**: Planned reducer and acceptance cases; no live policy/provider validation. Eligibility policy is authoritative in [spec FR-007](../spec.md#functional-requirements), current-read/consumer behavior in [entitlements](entitlements.md), and transactional writes/leases in [storage operations](storage-operations.md). This contract maps verified provider observations into those interfaces, not a second policy source.

## Provider observation to projection

The [manual renewal contract](manual-renewal.md) owns paid-term timing and Stripe Checkout payment mode; do not use recurring subscription/invoice status as a new-term grant.

| Verified observation | Projection/reducer action | User consequence |
|---|---|---|
| Checkout created or browser returned | Pending own order, no paid grant from navigation | Show progress |
| Successful owned payment for approved snapshotted term/price | Commit application paid term, allowed eligibility, paid-through and mapping/revision | Access configures subscriber key as needed |
| Payment pending, failed, unpaid or ownership/price/mode mismatch | No new paid term; retain retryable/terminal order outcome | No premature login; no arbitrary expiry extension |
| Current paid-through passed | Deny from timestamp even if old allowed=true remains stored | Fresh authorization offers plan selection and explicit payment |
| Explicit expired-user renewal succeeds | Commit newly purchased term/current confirmed catalog snapshot | Reuse identity/key and issue new credentials after setup |
| User returns while existing paid term is active | Reuse valid entitlement; no new order/charge | Complete login without Checkout |
| Administrative eligibility revocation | Denied projection plus changed revision/history | Subsequent issuance/refresh/management denies; issued JWT follows its existing bound |
| Late payment after browser/OAuth expiry | Commit verified term from original successful payment timestamp | Fresh authorization reuses payment if still valid, never revives expired OAuth |
| Duplicate/reordered event or uncertain effect | Fenced current-state reconciliation and durable outcome | No duplicate term, charge or lost payment |
| Unexpected recurring subscription/invoice event | No automatic entitlement extension; diagnose wrong configuration | Never silently enable auto-renewal |

Store normalized UTC seconds at boundaries and validate unit/range. Event creation order is not a monotonic business revision. Reconcile actual Checkout/payment status against the immutable order and provider ownership before reduction; no identity from email or arbitrary metadata. Use the shared fenced reducer for webhooks/reconciliation and commit meaningful plan/validity/eligibility changes with decision history. An unchanged duplicate records its outcome without repeating business effects.

## Management and uncertain results

All own-account management rechecks current-paid eligibility and ownership, including saved sessions. Cancellation of a current term is support-assisted under the manual-renewal contract; there is no end-of-period recurring cancellation/resume-renewal action. Hosted portal is disabled in this release, not conditionally enabled by redirect checks. Only the agreed positive-payment upgrade is exposed; payment-method/invoice/other management requires separate scope before exposure. Mid-term upgrades follow the [unused-term-credit/new-duration contract](plan-upgrade.md); self-service downgrades/cancellations/refunds are disabled and all associated requests or nonpositive upgrade quotes go to support email. Do not create recurring Stripe objects.

Unknown Stripe outcomes return pending/retryable state and persist recovery intent; never report a confirmed cancellation or successful payment from a timeout. Verified webhooks and bounded reconciliation converge through the same reducer. An account with multiple conflicting candidate subscriptions must not trigger another purchase or arbitrary tier selection; hold conflict for reconciliation, preserving paid records.

## Acceptance matrix

B003 covers every observation above, immediately-before/at/after paid expiry, manual renewal/no automatic charging, expired-to-purchase branching, mixed units and unsupported status/coverage. B005/B006/B007 cover concurrent duplicate effects, webhook ordering, provider-read failures and audited eligibility changes after earlier payment. B008/B012 cover delayed payment with closed browser, missed webhook recovery, changed plan/binding, rejected refresh after revocation and acceptance of a previously issued access token only within its existing expiration. B009 covers saved portal links, no management for ineligible users, CSRF/ownership and uncertain cancellation recovery. No fixture establishes live Stripe or host compatibility.
