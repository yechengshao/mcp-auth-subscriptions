# Billing implementation

- `handler.ts`: lazy Lambda entrypoint composing HTTP webhook, trusted native
  operations, SQS partial-batch handling and bounded scheduled replay.
- `dispatcher.ts`: closed native envelopes, owned records and current-paid
  management gates, typed results and support-only financial requests.
- `adapters/aws.ts`: official AWS SDK commands for strongly consistent reads,
  conditional cross-table transactions, sparse due-work queries, bounded SSM
  caches and delayed SQS sends carrying available native trace metadata.
- `adapters/stripe.ts`: official Stripe SDK, fixed-version one-time Checkout, approved price and
  account validation, authoritative payment reads and raw-byte webhook signatures.
- `service.ts`: durable purchase intent, idempotent Checkout recovery, atomic paid
  projection/history, upgrade quote/reservation/once-only credit, and fenced work.
- `lifecycle.ts`: pure paid-term reducer and original-payment-time term boundaries.

No additional monitoring SDK or worker is introduced. Callers supply validated
configuration; Lambda uses IAM credentials and secret parameters, not fixture
providers. Native operations must be IAM-restricted to access; access verifies
browser sessions and CSRF before invoking billing. No refund/cancel/downgrade API.

[Setup and remaining acceptance gates](../docs/billing-setup.md) cover test-mode
configuration, retained storage, native monitoring, immutable ARM64 packaging and
live verification. Source/runtime work is local; deployments and real provider
acceptance remain not_run. `npm run check` validates local code and simulations.
