/**
 * Read-only verifier for a deployed access endpoint. It sends only GET requests,
 * never follows redirects, never sends a real bearer token, and reports fixed
 * messages without echoing response bodies or headers. Checks that need a paid
 * subscriber, OAuth code exchange or writes are reported as not_run.
 */
export type CheckStatus = 'passed' | 'failed' | 'not_run';
export interface CheckResult { name: string; status: CheckStatus; detail: string }
export interface VerifyInput { baseUrl: string; issuer: string; resource: string }
export interface VerifyReport {
  schema_version: 1; mode: 'read_only'; checks: CheckResult[];
  summary: { passed: number; failed: number; not_run: number }; ok: boolean;
}
type Transport = (url: string, init: { method: 'GET'; redirect: 'manual'; headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
const NOT_RUN = [
  ['oauth-code-exchange', 'needs a registered client and a completed browser login'],
  ['refresh-rotation', 'needs an issued refresh credential from a paid subscriber'],
  ['subscriber-isolation', 'needs two paid test subscribers and their tokens'],
  ['rest-usage-plan-metering', 'needs paid keys and API Gateway usage data; quotas are not asserted'],
  ['onboarding-recovery', 'needs a live payment or a stalled transaction; writes are not allowed here'],
  ['release-identity', 'needs approved live deployment identifiers; compared in the deployment evidence'],
] as const;
function fail(detail: string): never { throw new Error(detail); }
function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('response is not a JSON object');
  return value as Record<string, unknown>;
}
async function json(response: Response): Promise<Record<string, unknown>> {
  if (response.status !== 200) fail(`unexpected status ${response.status}`);
  if (!response.headers.get('content-type')?.includes('application/json')) fail('response is not JSON');
  try { return asObject(await response.json()); } catch { fail('response is not valid JSON'); }
}
function httpsUrl(value: unknown, name: string): string {
  if (typeof value !== 'string') fail(`${name} is missing`);
  try { if (new URL(value).protocol !== 'https:') fail(`${name} is not HTTPS`); } catch { fail(`${name} is not a URL`); }
  return value;
}
/** Runs every read-only check, recording a fixed message for each failure. */
export async function verifyAccess(input: VerifyInput, transport: Transport = (url, init) => fetch(url, init)): Promise<VerifyReport> {
  const base = new URL(input.baseUrl);
  if (base.protocol !== 'https:' || base.search || base.hash) throw new Error('invalid_base_url');
  // The stage path is part of every route, so join onto it rather than resolving from the origin.
  const prefix = base.pathname.replace(/\/$/, '');
  const at = (path: string) => new URL(prefix + path, base.origin).toString();
  // The public issuer host advertises the metadata and hosts the login page; the base URL may be a raw execute-api stage.
  const issuerUrl = new URL(input.issuer);
  const metadataUrl = `${issuerUrl.origin}/.well-known/oauth-protected-resource`;
  const loginPath = `${issuerUrl.pathname.replace(/\/$/, '')}/login`;
  const get = (path: string, headers: Record<string, string> = {}) =>
    transport(at(path), { method: 'GET', redirect: 'manual', headers, signal: AbortSignal.timeout(10000) });
  const checks: CheckResult[] = [];
  async function check(name: string, work: () => Promise<void>): Promise<void> {
    try { await work(); checks.push({ name, status: 'passed', detail: 'matched the contract' }); }
    catch (error) { checks.push({ name, status: 'failed', detail: error instanceof Error && /^[a-z ].{0,120}$/.test(error.message) ? error.message : 'check failed' }); }
  }
  await check('discovery-protected-resource', async () => {
    const body = await json(await get('/.well-known/oauth-protected-resource'));
    if (body.resource !== input.resource) fail('resource does not match the configured MCP resource');
    if (!Array.isArray(body.authorization_servers) || !body.authorization_servers.includes(input.issuer)) fail('issuer is not advertised');
  });
  await check('discovery-authorization-server', async () => {
    const body = await json(await get('/.well-known/oauth-authorization-server'));
    if (body.issuer !== input.issuer) fail('issuer does not match the configured issuer');
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) httpsUrl(body[field], field);
    if (!Array.isArray(body.code_challenge_methods_supported) || !body.code_challenge_methods_supported.includes('S256')) fail('S256 PKCE is not advertised');
  });
  await check('jwks-public-only', async () => {
    const body = await json(await get('/jwks.json'));
    if (!Array.isArray(body.keys) || body.keys.length === 0) fail('no signing keys are published');
    const kids = new Set<string>();
    for (const key of body.keys) {
      const jwk = asObject(key);
      if (jwk.kty !== 'RSA' || jwk.alg !== 'RS256' || jwk.use !== 'sig' || typeof jwk.kid !== 'string') fail('a published key is not an RS256 signing key');
      if (['d', 'p', 'q', 'dp', 'dq', 'qi'].some(field => field in jwk)) fail('a published key contains private material');
      if (kids.has(jwk.kid)) fail('a key identifier is duplicated');
      kids.add(jwk.kid);
    }
  });
  await check('mcp-unauthenticated-challenge', async () => {
    const response = await get('/mcp');
    if (response.status !== 401) fail('protected MCP route did not return 401');
    if (!response.headers.get('www-authenticate')?.includes(`resource_metadata="${metadataUrl}"`)) fail('challenge does not advertise the metadata URL');
  });
  await check('health-unauthenticated-challenge', async () => {
    const response = await get('/health');
    if (response.status !== 401) fail('protected health route did not return 401');
  });
  await check('mcp-invalid-bearer-denied', async () => {
    const response = await get('/mcp', { authorization: 'Bearer invalid.verifier.token' });
    if (response.status !== 401) fail('an invalid bearer was not rejected with 401');
  });
  await check('billing-anonymous-redirect', async () => {
    const response = await get('/billing');
    if (![302, 303].includes(response.status)) fail('anonymous billing page did not redirect');
    const location = new URL(response.headers.get('location') ?? '', base);
    if (location.origin !== issuerUrl.origin || location.pathname !== loginPath) fail('anonymous billing page does not redirect to login');
  });
  for (const [name, reason] of NOT_RUN) checks.push({ name, status: 'not_run', detail: reason });
  const summary = { passed: checks.filter(c => c.status === 'passed').length, failed: checks.filter(c => c.status === 'failed').length, not_run: checks.filter(c => c.status === 'not_run').length };
  return { schema_version: 1, mode: 'read_only', checks, summary, ok: summary.failed === 0 };
}
/** CLI: node dist/scripts/verify_access.js <baseUrl> <issuer> <resource> */
if (process.argv[1]?.endsWith('verify_access.js')) {
  try {
    if (process.argv.length !== 5) throw new Error('usage: verify_access <baseUrl> <issuer> <resource>');
    const report = await verifyAccess({ baseUrl: process.argv[2]!, issuer: process.argv[3]!, resource: process.argv[4]! });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'verification_failed'}\n`);
    process.exitCode = 2;
  }
}
