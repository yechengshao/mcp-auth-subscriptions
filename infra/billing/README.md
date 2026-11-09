# Billing storage (B002)

`storage.yaml` is the authoritative CloudFormation template (JSON is valid YAML).
It creates only BillingState, BillingEntitlements and three unattached managed
policies. Runtime stacks attach the exported policy ARNs to their respective
roles; the future Pipe role gets the stream policy, never the access role.
There are no function, Cognito, API Gateway or background-stack dependencies.
Deployments require IAM capability acknowledgement; no deployment was run here.

Both tables use on-demand capacity, default AWS-owned encryption, point-in-time
recovery, deletion protection, and retain-on-delete/replace. PITR has a cost;
these durable payment records intentionally prioritize recovery. There is no TTL:
financial/idempotency/history cleanup requires a separately verified retention
process. Physical names derive from the environment-specific stack name; use a
separate stack per environment. Outputs contain resource references only.

BillingState's sparse DueWork index projects base keys only. Only validated work
records carry due_partition/due_sort; queries must strongly reread the base item
and conditionally claim it before acting. Billing can query its state and index,
read/update/put its two tables, but cannot Scan, batch-delete or delete history.
DynamoDB transactions authorize their constituent item actions. Immutability and
revision fences remain application transaction conditions, not IAM guarantees.
Access receives only GetItem/ConditionCheckItem on BillingEntitlements.

The NEW_IMAGE stream is unfiltered at the table. ReconciliationInsertFilter is a
mandatory input contract for the later Pipe: INSERT + WORK# + reconciliation_work
+ reconcile_payment + schema v1 + initial generation=1. No queue/Pipe is created by the storage template; runtime.yaml owns later delivery wiring. The exact
stream ARN avoids stream discovery permissions. The runtime template uses literal numeric generation=1 in the INSERT transformer; later run generations come from the common publisher. Live delivery remains unverified.

DynamoDB publishes native CloudWatch metrics automatically. This storage-only
stack executes no application code and creates no duplicate log groups or tracer.
Future runtime stacks must attach the existing AWS-native observability settings,
including structured CloudWatch logs, correlation IDs and Lambda X-Ray tracing.
Live resource creation, recovery, IAM authorization and telemetry remain not_run.

Local checks: `npm run check` and `cfn-lint infra/billing/storage.yaml`.

`runtime.yaml`, `release.ts` and the [setup guide](../../docs/billing-setup.md) now provide the billing runtime, queue/Pipe/replay and immutable-version rendering. Billing-only replay checkpoint rows share BillingState and cannot enter the work Pipe.
