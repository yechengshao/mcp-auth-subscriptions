# Contract: CloudWatch Operations and X-Ray Tracing

**Status**: Planned, not configured or live-validated. Shared by access (002) and billing (003); provision telemetry through their IaC. Spec 001 must separately implement compatible MCP tracing/trace-write IAM before end-to-end MCP traces can be claimed. Logging/tracing never changes authorization, payment or token behavior.

## CloudWatch logs and correlation

Create explicit CloudWatch log groups for access, authorizer and billing Lambda functions and REST API Gateway stage access/execution logs. Parameterize finite retention per environment, with deployment validation, IAM reader access and cleanup policy; no accidental never-expire defaults or secrets in outputs. Keep application JSON logs distinct from AWS platform logs. Use timestamp, level, service, environment, deployed version, operation/route template, sanitized outcome/error category, duration_ms, Lambda request_id, gateway request identifiers when available, correlation_id, and sampled trace/span IDs when available. Capture sanitized exception class/stack for unexpected failures without request/response bodies, locals or raw provider errors.

Generate or validate bounded opaque correlation IDs at trusted ingress; never let caller text inject fields, labels or log lines. Persist workflow correlation in order/work records; propagate it across exact internal billing invocations and billing SQS references/retries. A callback/webhook or delayed SQS job can have a different trace: correlate via persisted opaque workflow references and span links where supported, not a fabricated single trace lasting through human payment. Avoid logging full Cognito identities/customer/order provider objects; use approved opaque handles only when needed. Do not trust arbitrary incoming trace IDs as authorization or identity.

Never log Authorization/Cookie/Set-Cookie headers, OAuth codes/state/nonces/verifiers, access/refresh JWTs, usageIdentifierKey, native keys, private keys, Stripe secrets/signatures, Checkout URLs, raw request/query/body/provider payloads or card/customer details. JWT decoding is not redaction. Apply allowlisted structured fields before emission; SDK debug logging and automatic HTTP header/body capture stay disabled. API Gateway access formats use route templates/status/latency and request IDs, not full URL/query/header/token/authorizer context. Execution logging uses ERROR with data tracing disabled; do not enable full request/response logging for troubleshooting. Normal invalid-token/expired-session responses are categorized expected outcomes, not credential dumps or infrastructure failures.

## Metrics, dashboards and alarms

Prefer existing CloudWatch service metrics; add only the bounded custom series allowed by the economical defaults below (EMF or a compatible exporter). Dimensions are service/environment/operation/outcome, never user IDs, tokens, order IDs, correlation IDs or raw paths.

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

Use parent-based OpenTelemetry sampling so instrumented children honor sampled upstream context; don't add a new reservoir per process or export duplicate OTel/X-Ray spans. The 1% target is a supported ingress configuration, not a promise that AWS Lambda-managed independent roots obey that rate. Verify effective Lambda/SQS/Pipe sampling in acceptance and document provider-managed limitations. No guaranteed capture of every error trace: failure logs/metrics stay complete. Telemetry must use the inherited TLS/proxy trust; omit a collector/extension if compatible in-process export suffices, otherwise measure its memory/duration/export cost before adopting it.

Allow elevated diagnostic sampling/logging only for one service/operation and a configured expiry (default 30 minutes), with automatic reversion via existing configuration/deployment controls and the same redaction rules. Do not create a new permanent worker to toggle diagnostics. Configure an operator-supplied monthly observability budget and alert destination before production; monitor actual billed categories because AWS Budgets is not necessarily a per-feature hard cap. Budget alerts are advisory and delayed, not an automatic guarantee to stop spending. Keep cost allocation tags and review actual ingestion, stored bytes, custom-series count, alarms, trace recording/query and instrumentation Lambda overhead after rollout. Never promise zero charges or free-tier eligibility.

## X-Ray and OpenTelemetry

For production, enable active tracing on the deployed access, authorizer and billing Lambda functions and X-Ray tracing on the REST stage under the economical sampling profile; nonproduction tracing is opt-in. Instrument application/dependency spans with a supported OpenTelemetry/ADOT-to-X-Ray approach compatible with pinned Node.js/ARM64 runtime; pin and verify SDK/exporter/layer versions during implementation rather than assuming support or introducing legacy-only instrumentation. Validate Lambda runtime integration and avoid duplicate instrumentation/spans. Grant only required X-Ray export/sampling permissions to the relevant function roles; telemetry permissions do not grant data/signing/provider access. Document any X-Ray API action requiring wildcard resource scope instead of inventing an ARN constraint.

Trace application operations and dependency timings: internal Lambda calls, DynamoDB, SSM key fetch/cache outcomes (never key material), API Gateway key-management APIs, Stripe outbound calls and billing reconciliation. Record logical operation/host and sanitized outcome, not sensitive URLs or payloads; suppress credential-bearing query strings and automatic exception contents. Cache hits need not create remote-fetch spans. Keep trusted proxy/TLS settings and Stripe signature verification intact.

Propagate supported trace context through instrumented internal calls and AWS SQS system attributes where available; verify actual Lambda consumer linkage. Retry/redrive/replay may start new traces linked by correlation/operation references. EventBridge Pipe transforms must preserve allowed correlation fields; do not claim automatic continuous tracing across DynamoDB Streams/Pipes, Cognito/Stripe browser redirects or provider webhook delivery. Configure sampling at supported gateway/exporter controls and document Lambda-managed behavior; traces are sampled diagnostics, not guaranteed audit coverage. Mandatory structured failure logs and metrics remain independent of sampling.

Authorizer and MCP roles previously described as log-only require explicitly scoped trace-write permissions when tracing is adopted. Access/billing plans own their role changes; spec 001 runtime/report work remains a separate prerequisite for verified MCP segments. Local tests can validate exporters/redaction/IaC configuration but not cloud trace delivery or alarms.

## Required validation and rollout evidence

T001/T005/T007/T011 and B002/B010/B013 implement and check log groups/retention, REST data-tracing disabled, environment-appropriate Lambda/REST tracing and sampling, exporter/runtime compatibility, scoped telemetry IAM, dashboard/alarms and notification configuration. Test retention/log-size/verbosity limits, bounded series/alarm inventory, nonproduction defaults, diagnostic expiry/reversion, parent-based sampling and no duplicate exports, as well as JSON log schema, low-cardinality metrics, propagation across native calls/SQS/retries, and failure/cold-start/provisioning/payment scenarios with fake exporters and generated credentials. Assert secret sentinels never appear in logs, spans, exceptions or metric labels, including failed Stripe/JWT requests.

Future explicitly authorized live checks confirm CloudWatch ingestion/retention, dashboards, alarm delivery to the configured destination, trace service graph and request-to-dependency linkage, delayed-job correlation, sampling behavior and no leaked credentials. Record live checks as not_run until executed; never declare monitoring enabled merely because this contract or templates exist. No deployment, alarm test message or external notification is authorized by this documentation change.
