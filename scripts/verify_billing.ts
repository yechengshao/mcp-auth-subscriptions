/**
 * Local billing evidence verifier (B013). It runs the billing, observability and access suites once, then reports
 * the current-run counts and whether each required evidence test passed. Output is fixed test names and counts
 * only: test stdout/stderr is never printed, so no payloads, identifiers or secrets can leak into the report.
 * Live Stripe, deployed queue/replay and renewal checks are listed as not_run; this script never contacts AWS or Stripe.
 */
import { execFileSync } from 'node:child_process';

export type EvidenceStatus = 'passed' | 'failed' | 'missing' | 'skipped';
export interface EvidenceItem { id: string; requirement: string; test: string }
export interface LiveItem { id: string; status: 'not_run'; reason: string }

export const evidence: EvidenceItem[] = [
  { id: 'duplicate-concurrent-delivery', requirement: 'FR-012 SC-005', test: 'ten duplicate and concurrent webhook deliveries create one event, one subscription term and no second Checkout' },
  { id: 'webhook-deduplication', requirement: 'FR-012', test: 'webhook handling persists minimal event evidence and deduplicates signed deliveries' },
  { id: 'sqs-partial-batch', requirement: 'FR-010 SC-006', test: 'a partial SQS batch reports only the messages that must be retried' },
  { id: 'sqs-source-allowlist', requirement: 'FR-010', test: 'composed Lambda routes only allowed SQS source and reports individual invalid messages' },
  { id: 'queue-delay', requirement: 'FR-010', test: 'the first reconciliation is delayed by the configured delay and never by more than fifteen minutes' },
  { id: 'queue-visibility-and-dlq', requirement: 'FR-010 FR-012', test: 'the reconciliation DLQ receives a message only after five receives and accepts redrive only from its own queue' },
  { id: 'outbox-replay-window', requirement: 'FR-012 SC-006', test: 'outbox replay resends a stalled dispatch only after its lease and grace window, and never fans out' },
  { id: 'scheduled-recovery', requirement: 'FR-012', test: 'scheduled replay recovers an uncertain send without relying on a stream or browser' },
  { id: 'log-redaction', requirement: 'FR-011', test: 'HTTP logging preserves existing AWS identifiers and business responses without secret capture' },
  { id: 'error-redaction', requirement: 'FR-011', test: 'native/SQS/replay errors retain retry behavior without raw provider errors' },
  { id: 'cost-profile', requirement: 'FR-010 FR-011', test: 'economical profiles retain finite logs and disable nonproduction tracing by default' },
  { id: 'metric-bounds', requirement: 'FR-010', test: 'CloudWatch EMF has four bounded fixed series without an SDK' },
  { id: 'trace-propagation', requirement: 'FR-011 FR-013', test: 'native and delayed SQS relays keep correlation and AWS context without generating spans' },
  { id: 'trace-context-per-invocation', requirement: 'FR-013', test: 'Lambda reserved trace context is read per invocation and is not cached' },
  { id: 'access-billing-journey', requirement: 'FR-008 FR-015 FR-018', test: 'browser return before the webhook stays payment pending, provisions nothing and creates exactly one checkout' },
];

export const live: LiveItem[] = [
  { id: 'stripe-test-mode-signatures-and-checkout', status: 'not_run', reason: 'needs test-mode Stripe and deployed secrets (B014)' },
  { id: 'deployed-queue-and-replay-recovery', status: 'not_run', reason: 'needs deployed billing runtime and queue (B014)' },
  { id: 'expired-subscription-renewal-and-reconnect', status: 'not_run', reason: 'needs live test subscriber (B014, access T013)' },
  { id: 'cloudwatch-and-xray-delivery', status: 'not_run', reason: 'needs deployed Lambda and gateway telemetry' },
];

const suites = ['dist/tests/billing/*.test.js', 'dist/tests/observability/*.test.js', 'dist/tests/access/*.test.js'];

/** Runs the suites once and returns the TAP output; a failing run still yields its output for counting. */
function runSuites(): string {
  try {
    return execFileSync(process.execPath, ['--test', '--test-reporter=tap', '--test-isolation=none', ...suites], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === 'string' && stdout.length) return stdout;
    throw new Error('billing_suites_did_not_run');
  }
}

/** Parses TAP result lines into test-name statuses and the summary counts. */
export function parseTap(tap: string) {
  const statuses = new Map<string, 'passed' | 'failed' | 'skipped'>();
  for (const line of tap.split('\n')) {
    const match = /^\s*(not ok|ok) \d+ - (.+?)(?: # (SKIP|TODO)\b.*)?$/.exec(line);
    if (!match) continue;
    const [, verdict, name, directive] = match;
    const status = directive === 'SKIP' || directive === 'TODO' ? 'skipped' : verdict === 'ok' ? 'passed' : 'failed';
    // A name reported by two suites is passing only if no instance failed.
    const previous = statuses.get(name!);
    statuses.set(name!, previous === 'failed' || status === 'failed' ? 'failed' : previous ?? status);
  }
  const counts = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 };
  for (const [key, field] of [['tests', 'tests'], ['pass', 'pass'], ['fail', 'fail'], ['skipped', 'skipped'], ['todo', 'todo']] as const) {
    const found = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(tap);
    counts[field] = found ? Number(found[1]) : 0;
  }
  return { statuses, counts };
}

export function buildReport(tap: string) {
  const { statuses, counts } = parseTap(tap);
  const items = evidence.map(item => {
    const status: EvidenceStatus = statuses.has(item.test) ? (statuses.get(item.test) as EvidenceStatus) : 'missing';
    return { id: item.id, requirement: item.requirement, status };
  });
  const summary = {
    passed: items.filter(item => item.status === 'passed').length,
    failed: items.filter(item => item.status === 'failed').length,
    missing: items.filter(item => item.status === 'missing').length,
    skipped: items.filter(item => item.status === 'skipped').length,
    not_run: live.length,
  };
  const ok = counts.tests > 0 && counts.fail === 0 && summary.failed === 0 && summary.missing === 0 && summary.skipped === 0;
  return { schema_version: 1, mode: 'local_current_run', run: counts, evidence: items, live, summary, ok };
}

function main() {
  const report = buildReport(runSuites());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
