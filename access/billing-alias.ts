import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const parameterNamePattern = /^\/mcp\/(development|test|production)\/billing\/alias-arn$/;
const liveAliasPattern = /^arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+:live$/;
const cacheMilliseconds = 300_000;

/**
 * Reads the billing live alias that the billing runtime stack publishes. The parameter name is an
 * exact deploy-provided value; the value must be this account's live alias or the resolver fails closed.
 */
export function createBillingAliasResolver(parameterName: string | undefined, accountId: string, client?: SSMClient,
  now: () => number = Date.now) {
  if (!parameterName || !parameterNamePattern.test(parameterName) || !/^[0-9]{12}$/.test(accountId)) {
    throw new Error('invalid_billing_alias_parameter');
  }
  const ssm = client ?? new SSMClient({ maxAttempts: 2 });
  let cached: { value: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;
  return async (): Promise<string> => {
    if (cached && cached.expiresAt > now()) return cached.value;
    pending ??= (async () => {
      const result = await ssm.send(new GetParameterCommand({ Name: parameterName }));
      const value = result.Parameter?.Value;
      if (!value || !liveAliasPattern.test(value) || value.split(':')[4] !== accountId) {
        throw new Error('invalid_billing_alias_parameter');
      }
      cached = { value, expiresAt: now() + cacheMilliseconds };
      return value;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
