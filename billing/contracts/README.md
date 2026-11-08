# Local contract foundation

Run `npm ci` then `npm run check` from the repository root with Node 24+. TypeScript compiles before Node's built-in tests run. Tests share one process (`--test-isolation=none`) so this environment reports individual cases rather than only file summaries. No cloud credentials or services are required. Fixtures under `tests/fixtures/` are synthetic and must never be published as an offer catalog.

| Implemented artifact | Scope |
|---|---|
| `schemas.ts` | Strict schemas for catalog, purchased snapshot, entitlement, order, native requests, failure results and billing queue references |
| `validate.ts` | Environment/account checks, unique tier ordering, enabled duration/action selection, immutable snapshot copies, public display filtering, identity tuple hashing and owner-scoped record/reference checks |
| `service-term.ts` | Exclusive expiry from a verified-payment timestamp, fixed UTC days and original-day calendar clamping |
| `../../access/contracts/` | Selected session, purpose-bound transaction, identity-profile and refresh-record schemas plus expiry/ownership checks on server-loaded records |

Schemas reject unknown fields and unsupported versions without coercion or silently removing fields. Validation failures return fixed internal codes without reflecting submitted values. The service-term JSON Schema in specs remains authoritative and is imported into the emitted build; other executable schema objects are exported from the TypeScript modules.

The catalog uses keyed `plans`/`duration_options` objects. Each plan has `display`, `actions`, `usage_mapping` and purchase state; each duration has `label`, `service_term`, `amount_minor`, `currency`, `product_id`, `price_id`, `mode=payment` and purchase state. Plan/duration identifiers use ASCII letters, digits, underscores and hyphens, at most 128 characters. Currency uses lowercase three-letter codes; enabled prices must be positive integer minor units. `ssm_version` is the purchased positive parameter version. These validators cannot prove that a referenced AWS resource or Stripe price exists or matches the configured amount.

Selected stored rows use the entity discriminators `transaction`, `session`, `identity_profile`, `refresh_credential`, `order` and `entitlement`. Only temporary session/transaction/refresh rows accept `delete_after`; authority checks reject logical expiry before cleanup. These are an initial field set, not the final schema for every persisted transition. Refresh-record validation checks a candidate's usability/retention; consumed tombstones remain valid stored shapes but cannot authorize refresh.

Native requests are trusted IAM envelopes, not browser payloads. Shape validation is not caller authentication. Failure codes are closed per outcome; unknown combinations reject. Operation-specific success/pending payloads, HTTP status mapping and support rendering remain unimplemented. Validating a `manageSubscription` or `openPortal` request does not authorize an action or implement a provider mutation.

Session-context validation accepts server-loaded records only. It does not implement cookie issuance, Cognito verification, CSRF comparison, callback routing, session rotation or database transactions. Binding, grant-family, authorization-code, upstream-attempt, quote/reservation/credit/work/history schemas, explicit deployment budgets/read-policy tests, catalog caching and operation success results remain B001/T014 work. Transaction/race/recovery, handler, packaging/IaC and live acceptance remain separate gates; no implementation task is marked complete.
