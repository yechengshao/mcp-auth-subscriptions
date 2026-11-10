# Contract: Access DynamoDB Model and Atomic Operations

**Status**: Schemas/read/transaction adapter and retained-table template implemented locally; protocol transitions and deployment pending. Three application tables total: AccessState, BillingState and BillingEntitlements; table names/ARNs are deployment outputs. This contract owns physical access keys, fields and transaction boundaries, implementing existing token/onboarding rules. No access streams, queues or recovery schedule are required.

## Common conventions and ownership

Use string PK/SK, schema_version=1, integer revision and UTC epoch-second timestamps. Environment is trusted deployment configuration. Derive identity_key as SHA-256 of canonical UTF-8 JSON `[issuer,subject]`, matching billing. Generate an opaque subscriber_id once per verified identity/environment; email is never identity. Store no secrets in key attributes or indexes. Access Lambda alone owns access writes; authorizer/MCP/billing receive no access-table grants. Tables use encryption at rest, explicit deletion protection/retention and scoped logs; never log records or credential values.

Exact registered client/redirect/resource/scope and client-config version come from validated deployment registration, not a mutable browser record. No GSI or account-wide Scan is required: all authority reads use exact base keys and strong consistency. Billing entitlement lookup uses its shared identity-key algorithm; the catalog/purchased mapping contract remains unchanged.

The billing-owned entitlement projection includes the stable application `subscription_id` as well as the current plan, paid-through time, usage mapping and revision. Access uses that identifier only to call Billing's own-account upgrade operations; it does not read payment, customer, order or history rows from `BillingState`.

## One access table: AccessState

AccessTransient, AccessGrants and AccessBindings are logical record groups in ONE physical AccessState table, not separate resources. Preserve the PK/SK namespaces below; each row carries entity_type and schema_version so handlers/validators select the right shape. All access authority reads/transactions target AccessState. No streams or GSI are added by consolidation.

Enable DynamoDB TTL on optional delete_after for the table. Only eligible transient/expired-grant rows carry that field; identity profiles and subscriber bindings MUST omit it. Retention applies per entity, not as a blanket table cleanup rule. Server code controls all TTL/key/entity fields; browser payloads cannot select record types or expiration cleanup. Encryption, backup/deletion protection and IAM now apply to the single table.

## Logical group 1: Temporary login records

TTL attribute `delete_after`; logical validity is always checked separately. Records are scoped by environment.

| Entity | PK / SK | Fields and constraints |
|---|---|---|
| OAuth transaction | `ENV#e#TX#random_id` / `STATE` | purpose discriminator, registered client/redirect/resource/scopes/S256 challenge for onboarding or fixed local destination for management, original downstream state, issuer, client-config version, phase/revision, absolute expires_at, verified subscriber/identity only after Cognito validation, own-order ref, attempts/next_attempt_at/error category |
| Browser session | `ENV#e#SESSION#digest` / `SESSION` | purpose, authentication_stage, tx_id, CSRF digest, optional verified identity/subscriber, session revision, created/expires_at; shared browser-session contract controls cookie/rotation |
| Upstream Cognito attempt | `ENV#e#UPSTREAM#state_digest` / `ATTEMPT` | tx_id/session binding, nonce digest, server PKCE verifier, exact Cognito client/issuer/callback, expires_at, consumed flag/revision; verifier is required server-side secret, not merely a digest |
| Authorization code | `ENV#e#CODE#sha256(code)` / `CODE` | tx/subscriber/client/resource/redirect/S256 bindings, grant_id, issued/expires_at, consumed marker/revision; high-entropy opaque raw code returned once, never stored |

Transaction/session/upstream deadline is at most original start plus 1800 seconds; retries never extend it. Code deadline is min(issue+60 seconds, transaction deadline); refuse zero/expired validity. Store upstream verifier only until callback processing no longer needs it, then remove it. Code/session digests use high-entropy random inputs; do not use email/short user codes. Default cleanup is logical expiry plus 24 hours; this is disposable diagnostic/tombstone retention, not longer authorization. DynamoDB TTL deletion may lag; sensitive temporary fields are removed sooner after successful transitions where safe.

Both transaction purposes and the common 30-minute absolute cookie/session lifecycle follow [browser sessions](browser-sessions.md); no long-lived management credential or extra table.

## Logical group 2: Identity, grants and refresh credentials

| Entity | PK / SK | Fields and constraints |
|---|---|---|
| Identity profile | `ENV#e#IDENTITY#identity_key` / `PROFILE` | immutable verified issuer/subject and subscriber_id, schema/revision; no TTL; put-if-absent then consistently load the winner on races |
| Grant/family | `ENV#e#GRANT#random_grant_id` / `FAMILY` | subscriber/identity/client/resource/scopes, status=active/revoked, absolute refresh_expires_at fixed to paid-through at grant creation, rotation counter/revision, latest_access_expires_at, revoked_at/reason category |
| Refresh credential | `ENV#e#REFRESH#sha256(token)` / `TOKEN` | grant_id, subscriber/client/resource, sequence, status=active/consumed, issued_at, absolute expires_at; no raw token in storage |

Family and token rows use `delete_after >= max(refresh_expires_at, latest_access_expires_at)+86400`; revoked/consumed token tombstones remain through the full family deadline to detect replay, not removed at first use. Identity profile remains separate and must never be TTL-deleted when a grant expires. Grant IDs permit exact-key revocation; no scan required for one family. Browser logout targets its own bound family; administrative revoke-all needs a separately designed identity epoch/index before claiming support.

A refresh family belongs to one client/resource and its original paid term. Rotation cannot extend its deadline; renewed/re-purchased terms require fresh authorization, even when an identity/profile or key is reused. Cleanup retention is configurable but cannot shrink below the needed replay/recovery horizon. Redaction and encryption requirements apply to all records.

## Logical group 3: Persistent subscriber bindings

One stable binding per subscriber/environment/target REST stage, keyed `PK=ENV#e#SUBSCRIBER#subscriber_id`, `SK=REST#api_id#STAGE#stage`. Fields: plan_id, duration/catalog_version as purchased, entitlement_revision, usage_plan_id, API/stage, native api_key_id/value, state=pending/configured/error, operation_id, revision, attempts/next_attempt_at, lease_owner/fence/lease_until, sanitized error class and timestamps. No TTL on identity/key binding; expiry/revocation denies new credentials via entitlement/grant checks rather than deleting key identity.

Legacy logical ready=true maps to state=configured: a successful AWS setup response plus matching conditional persistence. It is not proof of global propagation and requires no routine read/probe. Retain confirmed payment on every setup failure; API-facing errors follow endpoint contract. Provisioning occurs only on bounded access HTTP requests, not in token issuance.

Persist cryptographically random candidate API-key value and stable operation identity under a conditional binding lease before CreateApiKey; supply that same value on retries rather than generating a new key after a timeout. Restrict and encrypt its storage like any native key. On uncertain creation/association, reconcile exact known key/association state, resolving duplicate/conflicting outcomes before effects; never treat an AWS name alone as unique or blindly create a replacement. API operation/provider uniqueness behavior must be verified in packaged/native fixtures and live acceptance; unresolved outcomes fail safely with support/retry guidance.

## Atomic operation rules

1. Authorize validates caller fields, then conditionally creates transaction/session/upstream attempt. Callback checks expiry/session/state/nonce and exchanges Cognito code; atomically consume upstream attempt, bind verified profile and rotate session/advance transaction. Profile put-if-absent may precede this transaction without granting access. Uncertain callback code exchange returns safe restart/recovery, not an identity bypass.
2. Resume checks current paid entitlement and configured binding, then atomically condition-check those exact revisions, transition tx code_ready→code_issued and insert one code digest/grant identifier. One-use code stays consumed after redemption. Duplicate resume cannot issue another code; lost browser response requires safe reauthorization, not returning stored raw codes.
3. Code exchange strongly reads code/transaction and authoritative grant inputs; prepare candidate credentials but release nothing until a TransactWriteItems consumes the unused code, marks tx redeemed, creates family and refresh digest, and condition-checks current billing entitlement/binding versions and validity. No grant is usable from an uncommitted transaction. A lost token response cannot safely replay the code; return invalid_grant and require fresh authorization rather than retaining recoverable raw credentials.
4. Refresh validates active token/family/client/resource, then atomically marks old token consumed, inserts replacement digest, increments family counter/latest_access_expiry and condition-checks current entitlement/binding. Concurrent use has one winner; known consumed-token replay revokes that family and returns invalid_grant. Lost refresh response may require reconnect; do not weaken replay detection. Revocation atomically updates family status so future rotations fail, without invalidating issued offline-verified JWTs.
5. Billing owns entitlement writes. For token/resume cross-table transaction condition checks, access receives GetItem and narrowly scoped ConditionCheckItem on the exact billing entitlement table, never Put/Update/Delete or billing payment tables. These checks establish authority at transaction commit, not an impossible lock against all later subscription changes; issued JWTs retain documented expiry/revocation bounds.
6. Provisioning follows external-generation exclusion below and claims/renews lease with monotonic fence, operates under saved plan/operation identity, and conditionally commits configured state only for its current owner/fence and still-matching billing entitlement revision. AWS and DynamoDB are not one atomic transaction; uncertain external outcomes persist across HTTP retries. A stale request cannot publish a binding for an old tier. Config defaults: 10-second provisioning work budget per request, 60-second lease, at most 5 automatic attempts per operation with 2–30-second exponential jittered backoff; SDK timeouts must fit the budget. Exhaustion provides support/manual retry, never new payment; all values are deployment-validated and do not extend OAuth expiry.

Retain billing grants consistent with read-only ownership while implementing transactions across tables in the same account/region. Avoid condition-checking and updating the same item separately in one DynamoDB transaction; put conditions on that item's update. Never use TTL deletion, a GSI result, browser fields or current catalog in place of authoritative purchased entitlement/binding checks.

## External mutation generation and takeover

Add binding fields mutation_generation, desired_entitlement_revision, mutation_status=idle|reserved|dispatching|acknowledged|uncertain|repair_required, step=create_key|remove_association|add_association, exact target/key identifiers, owner_invocation_id, step_started_at and sanitized result evidence. Generations are monotonic; entitlement changes update desired state but never silently replace an unresolved external generation.

Before EACH AWS mutation, conditionally reserve/mark that step dispatching against its generation, current owner/fence and target. Only that invocation can send it; disable transparent SDK retries for non-idempotent native mutations and use the persisted recovery protocol. Successful AWS response may record acknowledged evidence for its own generation even after loss of its original lease, but cannot dispatch a further step or mark a newer generation configured. Check the durable owner/generation immediately before every subsequent mutation.

A lease timeout permits read-only recovery, not permission to start a conflicting AWS mutation. If the former invocation may still dispatch or has an outstanding/unknown native call, keep that generation uncertain, block new key/association mutation and return the existing retry/support error. Do not infer closure from elapsed time, a Lambda timeout, lease expiry or a single management read. Recovery may resolve an acknowledged exact operation and its expected state; if it cannot establish that the previous invocation/call is closed, retain repair_required for operator/provider-assisted reconciliation. This deliberately favors safe blocking over an unsupported exactly-once guarantee.

Only after closure is established can a new owner reconcile the desired association and proceed, without blindly removing an association chosen by a newer subscription revision. Local conditional persistence remains mandatory; a database fence does not fence AWS. A stale-success record belongs only to its original generation and cannot authorize further effects. Tests must model a late old remove/add after lease expiry, entitlement change during an outstanding call, and crash between reservation/dispatch/acknowledgment; assert no newer tier mutation while the old generation is unresolved. Routine successful uninterrupted setup still performs no follow-up read/probe; these reads occur only in exceptional recovery.

## Required schema/transaction acceptance

T014/T022 define machine-validating fixtures for every row/enum/epoch field and cross-contract identity/snapshot mapping. T015/T016/T017/T018 implement exact-key reads and conditional transactions. Test same-identity races, session/upstream binding, expiry before TTL deletion, one-use redemption/lost response, refresh race/replay/revocation, billing revision change during signing, durable candidate key after AWS timeout, provisioning lease fencing, paid reconnect after transient cleanup and no API-key duplication. T005/T011 validate one-access-table IaC/selective-TTL/IAM and the three-table overall inventory, absence of access stream/queue/Scan grants, and redacted local evidence; live AWS uniqueness/permissions tests remain separately authorized. No tables are created by this planning document.
