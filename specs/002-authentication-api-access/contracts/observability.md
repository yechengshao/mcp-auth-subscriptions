# Contract: CloudWatch Operations and X-Ray Tracing

**Status**: [Node instrumentation and prepared monitoring IaC](../../../observability/README.md) implemented locally; actual business-handler/stage/role wiring and cloud validation remain pending. Shared by access (002) and billing (003). Spec 001 MCP instrumentation is separate; no end-to-end cloud trace is claimed. Logging/tracing never changes authorization, payment or token behavior.

## CloudWatch logs and correlation

Create explicit CloudWatch log groups for access, authorizer and billing Lambda functions and REST API Gateway stage access/execution logs. Parameterize finite retention per environment, with deployment validation, IAM reader access and cleanup policy; no accidental never-expire defaults or secrets in outputs. Keep application JSON logs distinct from AWS platform logs. Use timestamp, level, service, environment, deployed version, operation/route template, sanitized outcome/error category, duration_ms, Lambda request_id, gateway request identifiers when available, correlation_id, and sampled AWS trace/parent IDs when available. Capture sanitized exception class/stack for unexpected failures without request/response bodies, locals or raw provider errors.

Generate or validate bounded opaque correlation IDs at trusted ingress; never let caller text inject fields, labels or log lines. Persist workflow correlation in order/work records; propagate it across exact internal billing invocations and billing SQS references/retries. A callback/webhook or delayed SQS job can have a different trace: correlate via persisted opaque workflow references and native trace linkage where supported, not a fabricated single trace lasting through human payment. Avoid logging full Cognito identities/customer/order provider objects; use approved opaque handles only when needed. Do not trust arbitrary incoming trace IDs as authorization or identity.

Never log Authorization/Cookie/Set-Cookie headers, OAuth codes/state/nonces/verifiers, access/refresh JWTs, usageIdentifierKey, native keys, private keys, Stripe secrets/signatures, Checkout URLs, raw request/query/body/provider payloads or card/customer details. JWT decoding is not redaction. Apply allowlisted structured fields before emission; SDK debug logging and automatic HTTP header/body capture stay disabled. API Gateway access formats use route templates/status/latency and request IDs, not full URL/query/header/token/authorizer context. Execution logging uses ERROR with data tracing disabled; do not enable full request/response logging for troubleshooting. Normal invalid-token/expired-session responses are categorized expected outcomes, not credential dumps or infrastructure failures.

## Metrics, dashboards and alarms

Prefer existing CloudWatch service metrics; add only the bounded custom series allowed by the economical defaults below (native CloudWatch EMF). Dimensions are service/environment/operation/outcome, never user IDs, tokens, order IDs, correlation IDs or raw paths.

The table is diagnostic coverage, not a requirement for a paid custom metric/alarm per cell; use native metrics, saved queries and on-demand traces where possible.

| Surface | Diagnostic coverage |
|---|---|
| REST gateway | Count, latency/integration latency, 4xx/5xx, throttling; separate expected authentication denial/429 from integration/authorizer failures |
| Each Lambda | Errors, throttles, duration percentiles, concurrency and timeout-near-limit; structured cold-start observations where supported |
| Access application | Login/code/refresh outcomes, unexpected signing/SSM failures, provisioning latency/pending age/retry exhaustion and failed readiness |
| Billing application | Signature rejection, webhook commit failures/latency, duplicate-event outcomes, Stripe dependency failures/latency, reconciliation pending age and lease conflicts |
| Billing SQS/Pipe/replay | Visible backlog, oldest message age, DLQ messages, failed/dropped Pipe deliveries, DLQ/redrive, replay failures and durable due-work age; do not claim immediate SQS enqueue-age visibility during its delay |
| DynamoDB | Read/write throttles, system errors, latency and conditional/transaction conflicts categorized as expected race versus exhausted failure |

Provision shared-navigation dashboards and alarms through component-owned IaC with explicit evaluation windows, thresholds, missing-data policy and notification destination inputs; operator values are reviewed before deployment, not invented production defaults. Durable pending age is required to detect stuck jobs even when a queue is empty. CloudWatch/X-Ray cost, retention, sampling and verbose-log budgets are explicit configuration. Runbooks map alerts to log queries, request/work correlation, trace inspection, safe billing reconciliation and controlled DLQ redrive; alerting never automatically repeats a charge.

## Economical default profile

These are initial configurable defaults, not AWS free-tier assumptions or billing caps. Deployment changes must report expected metric/alarm/trace volume and preserve privacy/failure visibility.

| Setting | Production default | Development/test default |
|---|---|---|
| CloudWatch Logs retention | 14 days | 3 days |
| Application log level | WARN, plus allowlisted INFO business-transition/final request-summary records | WARN; DEBUG only in an explicit bounded diagnostic session |
| Routine successful `/mcp`/authorizer/status/health polling logs | No per-request application INFO/debug; retain concise gateway access/platform logs | Same; no synthetic traffic just to populate dashboards |
| X-Ray | Active tracing; supported REST ingress sampling targets 1%, reservoir 0 requests/sec | Disabled unless an explicit diagnostic test enables it |
| Dashboards | One shared dashboard using primarily native metrics | None by default; use saved queries/native console views |
| Custom metrics | At most 4 concrete series per environment/account/region, standard 60-second resolution | None by default; enable selected series only for validation |
| Alarms | At most 10 explicitly selected essential alarms | Disabled by default; opt-in for alarm integration tests |

Always retain sanitized unexpected failure logs and critical payment/order/entitlement transitions with correlation, regardless of trace sampling. Do not log each duplicate delivery, cache hit, polling response or successful SDK call; aggregate expected denials/retries and use native counters. Cap each application log event at 4 KiB of allowlisted fields and truncate sanitized stacks; omit rather than truncate secret-bearing input. API Gateway uses one compact stage access-log format, ERROR execution logging and data tracing off; avoid duplicate framework/SDK access logs. Retention reduces stored volume, not ingestion charges; controlling event frequency/size is also required. Detailed billing/support evidence lives in durable billing records and Stripe, not verbose logs.

Default custom series are BillingWebhookCommitFailureCount, BillingReconcileDueAgeSeconds, AccessProvisioningFailureCount and AccessProvisioningAttemptLatencyMs, with only fixed service/environment dimensions and no dynamic labels. Any additional dimension combination counts against the four-series budget; omit unused metrics rather than emitting empty combinations. Use native Lambda/API Gateway/SQS/DynamoDB metrics for everything else. Durable due-work age is emitted from existing billing replay, not a new monitoring Lambda or table scan. Access attempt latency measures request-driven work, not an alarm that demands activation while the browser is closed.

Select the ten production alarms jointly across specs: per-function Lambda Errors (access, authorizer, billing), API Gateway 5xx, billing DLQ nonempty, billing queue oldest-ready-message age, billing durable due-work age, Pipe delivery failures, aggregate Lambda throttles, and DynamoDB read/write throttles via one metric-math alarm. Thresholds/windows/missing-data policy remain deployment inputs, with billing delays/backoff reflected in age thresholds. Other metrics are dashboard/query-only until justified. Prefer native metric-math alarms where supported rather than exporting redundant custom series. Alarm destinations and any paid cross-account/custom dashboard features require explicit configuration.

Disable API Gateway per-method detailed metrics, Lambda Insights, enhanced/container/database monitoring, CloudWatch Application Signals, CloudWatch Logs indexing/live-tail/continuous scheduled queries, X-Ray transaction-search/extra indexing and high-resolution custom metrics unless explicitly selected with a cost estimate. Use narrowly time-bounded Logs Insights and X-Ray queries for incidents; no recurring broad trace scans. Keep billing record retention independent from shorter operational-log retention.

Use AWS-native Lambda/API Gateway X-Ray tracing and sampling only; do not add OpenTelemetry, third-party tracing SDKs, collectors, custom segments/exporters or application samplers. The 1% target is a supported REST-ingress rule, not a promise for independent Lambda roots. Verify native Lambda/SQS/Pipe behavior in live acceptance. Native service traces do not include custom application/Stripe/tool subsegments; sanitized CloudWatch timings supply those diagnostics. Failure logs/metrics remain independent of trace sampling.

Allow elevated native AWS diagnostic settings only through a bounded operator/deployment change (default 30-minute window), with restoration through those controls and unchanged redaction; no application sampling override is implemented. Do not create a new permanent worker to toggle diagnostics. Configure an operator-supplied monthly observability budget and alert destination before production; monitor actual billed categories because AWS Budgets is not necessarily a per-feature hard cap. Budget alerts are advisory and delayed, not an automatic guarantee to stop spending. Keep cost allocation tags and review actual ingestion, stored bytes, custom-series count, alarms, trace recording/query and instrumentation Lambda overhead after rollout. Never promise zero charges or free-tier eligibility.

## AWS-native X-Ray

Production enables Active tracing on deployed access/authorizer/billing Lambda functions and X-Ray on the REST stage; nonproduction is opt-in. AWS creates/manages service segments. The application logs existing tracking IDs and relays supported metadata but never generates spans or exports trace documents. Preserve narrow native X-Ray write permissions and scoped log permissions; telemetry grants no signing, customer or provider-data rights. Document APIs requiring wildcard resource scope.

Record sanitized operation/failure durations in CloudWatch for internal calls, DynamoDB, SSM, gateway provisioning and Stripe. Do not capture URLs, arguments, keys or response bodies. Native AWS integration determines available trace detail; do not claim arbitrary dependency calls are automatically traced. Relayed native-envelope/SQS metadata is diagnostic, never authorization/payment authority. Delayed work/webhooks/replay may start new traces while retaining saved workflow correlation. Pipe/gateway/Lambda Web Adapter linkage needs live verification.

MCP uses the same AWS header format and native platform tracing in spec 001. Local tests can validate metadata/logging/IaC, not actual AWS trace delivery or alarm notifications.

## Required validation and rollout evidence

T001/T005/T007/T011 and B002/B010/B013 implement/check finite log groups, REST ERROR logging with data tracing/detailed metrics off, native Lambda/stage tracing, scoped IAM, dashboard/alarms and destinations. Test JSON/size/redaction, context isolation/relay, bounded EMF series/alarm inventory, environment defaults and failure/transition cases with controlled handlers and secret sentinels. Test that no monitoring SDK/exporter dependency is present.

Separately authorized live checks validate ingestion/retention, real stage/service graph linkage, native sampling, notification delivery and safe diagnosis. Keep these not_run until executed; templates/log helpers do not establish deployed monitoring. No deployment or notification is authorized by editing these documents.

## Local integration status

The [implementation guide](../../../observability/README.md) owns the stdlib-only decorators, native metadata relay, EMF and generated template details. Real OAuth/payment/job handlers, stage/role wiring and critical-transition/metric callsites remain pending under their existing tasks. No additional task is marked complete and no cloud resource has been changed.
