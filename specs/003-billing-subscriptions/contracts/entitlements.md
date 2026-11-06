# Contract: Billing-Owned Entitlements for Access

**Status**: Logical boundary; planned physical keys/operations are defined in [storage operations](storage-operations.md), not yet deployed. Separate billing Lambda/DynamoDB and issuer-side subscription enforcement and token-only authorization are confirmed. [Onboarding contract](checkout-onboarding.md), [access token contract](../../002-authentication-api-access/contracts/authorization.md), [onboarding contract](../../002-authentication-api-access/contracts/onboarding-workflow.md).

## Ownership and trusted identity

Billing verifies Stripe events/reconciles authoritative provider state and writes orders/customer/subscription/event/projection records. Access coordinator verifies upstream Cognito login, preserves OAuth transactions and calls billing internally with immutable `(identity_issuer, identity_subject)`. Derive that pair only from verified login/grant state, never browser customer/subject/email. The access issuer resolves it through the verified access-owned grant; downstream service JWT issuer is not the Cognito ownership issuer. MCP has no Stripe, DynamoDB, OAuth or signing configuration/dependencies/IAM.

Billing owns writes and status→paid-validity policy. Access coordinator/token issuer gets narrowly scoped read access to the entitlement interface only, not arbitrary payment/customer/event data. Access's separate state owns grants/revocation and native subscriber-key bindings; billing does not write keys, mint tokens or decide their cryptographic expiry. Spec 002 owns REST webhook/method/integration/invocation resources; spec 003 defines the billing alias and webhook operation/raw-body verification.

Provider-to-projection cases follow the [lifecycle reducer contract](subscription-lifecycle.md), with eligibility policy remaining in spec FR-007.

## Logical current-read model

| Field | Meaning |
|---|---|
| identity_issuer, identity_subject | Verified immutable Cognito identity key |
| allowed | Billing policy eligibility, not native key readiness |
| plan_id | Approved stable catalog tier; never an arbitrary client/Stripe metadata override |
| valid_until | Explicit UTC paid access expiry, checked without relying on database deletion |
| revision | Monotonic committed decision revision, including meaningful plan/status/validity changes |
| updated_at | Trusted processing/reconciliation observation time |

Use the physical base-table key/resource/read policy in the storage-operation contract before implementing adapters. Require consistent reads; an eventually consistent index or TTL deletion is not authorization. Missing/denied/expired/malformed/unavailable projection fails closed for login, token issuance and refresh. `allowed=true` still requires access-owned unrevoked grant/current ready key binding before credentials are issued/refreshed. The authorizer relies on the signed JWT alone within the [access revocation bounds](../../002-authentication-api-access/contracts/authorization.md#denial-and-revocation), without entitlement reads.

Current plan/revision changes invalidate stale activation work. Access must reconcile the matching tier/native usage-plan association and refresh the client token when its plan/revision observations differ. Billing need not provision native keys to commit a paid entitlement; delayed native association is activation pending in access. Expiry/revocation blocks issuance/refresh regardless of delayed key cleanup; outstanding tokens follow the linked access revocation bounds.

## Bootstrap and recovery

Billing storage bootstrap needs no Cognito ID or processor/gateway alias; supply its exact read interface to access. Base REST API precedes callback URLs/functions; gateway methods/stage follow exact alias outputs. Purchase-only enrollment operations use the coordinator's scoped IAM invocation with verified identity; management additionally enforces [access FR-004](../../002-authentication-api-access/spec.md#functional-requirements), including current-paid checks on existing sessions/links. Stripe webhook verifies signature over exact received bytes and does not require human login/native API key.

Signed event verification precedes writes. Commit durable event outcome, subscription state and projection consistently; duplicates/reordering/concurrent workers cannot regress state or acknowledge partial success. Reconcile to authoritative provider state after uncertain outcomes. A short-lived transaction request idempotency token alone is not the durable provider event ledger. Paid subscription persists if the OAuth transaction expires; fresh sign-in reuses the entitlement without another charge.

## Acceptance and sources

Local tests cover plan/expiry/revision transitions, exact identity binding, unpaid enrollment, duplicate/reordered/concurrent event recovery, payment-after-continuation expiry, pending native activation and zero MCP calls on denied access. Signed token/code/refresh behavior belongs to access. Live Stripe/Cognito/REST/DB evidence remains separate and not_run under local-only instruction.

[Stripe webhook verification/retries/order](https://docs.stripe.com/webhooks), [subscription lifecycle](https://docs.stripe.com/billing/subscriptions/webhooks), [DynamoDB transaction semantics](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html). Catalog/eligibility defaults are project policy assumptions awaiting billing technical planning.

## Durable activation delivery

Billing atomically commits a sanitized activation-outbox record with its decision. Include opaque event/order references, verified identity binding, committed revision and status for scoped internal readers; exclude payment secrets and OAuth credentials. Access owns the SQS handler in the existing access Lambda and managed stream-to-activation-queue Pipe; billing never writes access state or invokes access transitions. Physical table/key/transaction/stream/filter/read grants follow the storage-operation contract; deployment outputs remain prerequisites for live adapters.

Stream delivery may duplicate or expire. Keep durable outbox/delivery progress and a bounded paginated recovery-read interface for missed notifications beyond stream retention; access owns delivery checkpoints outside billing state. A webhook acknowledges a billing commit regardless of access progress. Queue notifications prompt consistent projection reads and conditional transitions against the linked identity/order/current revision; they cannot establish authority themselves. Early delivery is recovered when linking an order and by scheduled reconciliation. Late payment survives OAuth expiry and is reused on fresh sign-in.
