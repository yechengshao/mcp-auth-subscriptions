# AWS-native auth/billing monitoring

Use CloudWatch Logs/metrics and AWS-managed Lambda/API Gateway X-Ray tracing. Application monitoring uses Node standard libraries only: no OpenTelemetry, third-party tracing SDK, collector, exporter, custom segments or monitoring worker.

The reusable logging helpers and prepared infrastructure are implemented locally. The real billing HTTP/native/SQS/replay and REQUEST-authorizer handlers now attach these helpers, including safe SDK/JWKS dependency timing and critical paid commits. The access OAuth/session/token handlers and gateway stage wiring remain pending. No deployed auth/billing monitoring is claimed.

## Application logs and tracking

`Telemetry` writes bounded allowlisted JSON to stdout for startup, unexpected failures and verified critical transitions. Fields include service/environment/release, correlation/request IDs, duration and safe stack locations. Tokens, headers, raw error messages, query/body/provider objects and customer/payment data are excluded. Ordinary successful polling emits no application log volume. `dependency()` measures failure duration in logs; it does not create X-Ray subsegments.

HTTP, REQUEST-authorizer, native-operation, SQS-record and replay decorators preserve response/retry behavior and redact unexpected platform errors. They do not authenticate identity, verify payment, claim work or implement the SQS batch dispatcher. OAuth errors retain `server_error`; webhook exceptions remain non-2xx; expected authorizer `Unauthorized` stays unchanged. Existing SDK/framework raw logging must remain disabled in future bootstraps.

```typescript
// Future access entrypoint, after the real token handler exists:
import { Telemetry, withAccessHttpTelemetry } from './observability.js';
import { configFromEnvironment } from '../observability/config.js';
const telemetry = new Telemetry(configFromEnvironment('access', process.env));
const observed = withAccessHttpTelemetry(telemetry, 'http.token', actualTokenHandler);
```

Node reads current `_X_AMZN_TRACE_ID` or forwarded AWS metadata per invocation, never at module load. `trace_id`/`trace_parent_id` describe existing sampled AWS context; the application generates no trace/span IDs. Opaque correlation IDs are preserved or generated independently for log searches. Saved job context overrides an outer batch/request context and is restored afterward.

`propagateNative` relays existing tracking metadata in optional trace_context; `propagateSqs` uses AWS AWSTraceHeader system attributes without adding credentials to the reference-only message body. The body must already contain its durable workflow correlation ID. These relays support diagnosis but cannot promise that AWS creates one continuous trace across Invoke, SQS/Pipes, redirects or webhooks. Native service linkage needs live verification. The Python MCP service reads the same header format without a tracing SDK.

Four fixed CloudWatch EMF series are available: BillingWebhookCommitFailureCount, BillingReconcileDueAgeSeconds, AccessProvisioningFailureCount and AccessProvisioningAttemptLatencyMs. Standard-resolution dimensions are service/environment only. Metrics default off outside production. Actual transition/metric emission belongs at verified commit/provisioning/replay callsites; no new worker or table scan is added.

## AWS infrastructure

`infra/observability/template.ts` generates the committed CloudFormation JSON (`npm run render:observability`). It prepares five log groups, scoped logging/conditional native X-Ray policies, a REST-stage 1% zero-reservoir sampling rule, one production dashboard and ten opt-in alarms. Production retention is 14 days, other environments 3; retained groups still expire their events under that policy.

The stack creates no function, gateway/stage/account, queue, table, customer secret or SNS subscription. Supply actual resource names, sampling priority, alarm thresholds/windows/missing-data policy and an existing permitted SNS destination. Alarms default disabled until those resources are ready. Function owners attach exported managed policies and merge `lambdaTelemetrySettings` into their runtime environment/TracingConfig. Gateway owners merge `gatewayStageSettings` and attach the log policy to the configured account logging role. No shared account setting is changed here.

Production defaults to native Active tracing; development/test is opt-in. AWS controls segment creation and Lambda sampling. The 1% rule applies to the supported REST stage, not every independent Lambda root. There is no application sampler or sampling timer. Any elevated AWS sampling must be a bounded operator deployment change and restored afterward. Monthly budget/alerts remain operator prerequisites, not an application spending cap.

Native X-Ray covers supported service/invocation timing and failures. Tool, Stripe and arbitrary application steps do not get custom spans. Use safe CloudWatch error/transition timings for those details. `xray:PutTraceSegments/PutTelemetryRecords` and gateway `logs:DescribeLogGroups` need wildcard resources; log writes/stream metadata are scoped to named groups. Business-data permissions remain unchanged.

## Verification

`npm run check` compiles and tests contracts, correlation isolation, redaction, native metadata relay, EMF budgets and generated-template drift. cfn-lint 1.59.0 validates the prepared template; CI repeats local checks without AWS credentials. Pure utilities need no logger, and there is no trace-export failure/flush path to test.

Actual handler/stage/role wiring, dependency callsites, live CloudWatch retention/ingestion/alarms, effective native sampling, MCP gateway linkage and ARM64 behavior remain pending. No cloud deployment, image publication, payment or notification ran. Detach dependent stage/role settings before removing policies; keep retained diagnostic logs under the documented cleanup policy.
