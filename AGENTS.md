# Implementation requirements

When implementing any application handler, worker, external-service adapter or infrastructure change, include CloudWatch structured logging and AWS-native Lambda/API Gateway X-Ray tracing as part of the change, following the shared [observability contract](specs/002-authentication-api-access/contracts/observability.md).

- Carry correlation IDs across requests, internal calls and durable billing work; capture sanitized failures and dependency timings.
- Apply the contract's environment-specific sampling, retention, verbosity and metric/alarm budgets; tracing need not be enabled in local development.
- Never emit credentials, cookies, tokens, keys, raw provider payloads or customer/payment details in logs or spans.
- Test redaction and relevant trace propagation/configuration alongside the feature; pure validation utilities need no standalone logger or tracer, and callers own their sanitized telemetry.
- Treat observability coverage as part of implementation review, not deferred cleanup; distinguish local instrumentation/configuration tests from unrun live CloudWatch/X-Ray delivery checks.

Use AWS-native monitoring only: do not add OpenTelemetry, third-party tracing SDKs, custom span exporters, collectors or monitoring workers. Preserve correlation IDs and available AWS tracking metadata; detailed application timings belong in sanitized logs, not custom spans.
