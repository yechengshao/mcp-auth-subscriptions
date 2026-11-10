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
- `ports.ts`: repository, queue and payment-provider boundaries used by the billing
  workflows; AWS and Stripe SDKs stay in `adapters/` and are assembled in `handler.ts`.
- `lifecycle.ts`: pure paid-term reducer and original-payment-time term boundaries.

Shared schema primitives, canonicalization, identity partitioning and the billing-owned
entitlement projection live in the repository-level `contracts/` package. Access consumes
that projection contract without importing billing implementation modules.

No additional monitoring SDK or worker is introduced. Callers supply validated
configuration; Lambda uses IAM credentials and secret parameters, not fixture
providers. Native operations must be IAM-restricted to access; access verifies
browser sessions and CSRF before invoking billing. No refund/cancel/downgrade API.

[Setup and remaining acceptance gates](../docs/billing-setup.md) cover test-mode
configuration, retained storage, native monitoring, immutable ARM64 packaging and
live verification. Source/runtime work is local; deployments and real provider
acceptance remain not_run. `npm run check` validates local code and simulations.

To build the isolated Lambda image locally, use digest-pinned Node.js 24 build
and Lambda base images. The helper targets ARM64, runs the complete root checks in
the build stage, installs only the locked billing runtime dependencies in the
image, and writes local source/lock/template hash evidence. It does not publish
the image or claim an ECR manifest digest:

```sh
npm run package:billing-image -- \
  --build-image 'node:24-bookworm-slim@sha256:REPLACE_WITH_64_HEX_DIGEST' \
  --runtime-image 'public.ecr.aws/lambda/nodejs:24@sha256:REPLACE_WITH_64_HEX_DIGEST' \
  --tag 'billing-local:REPLACE_WITH_RELEASE'
```

The result is saved under `.artifacts/`. A Docker daemon is required. An ECR
manifest digest is available only after the separately authorized publication
workflow pushes the image.
