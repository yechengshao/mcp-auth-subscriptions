import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { identifierPattern } from '../contracts/patterns.js';
import { createTtlCache } from '../contracts/ttl-cache.js';
import type { UsageBindingTarget } from './usage_bindings.js';

/** Resolves the REST API this deployment protects. Each call returns the current target or throws. */
export type RestApiTargetSource = () => Promise<UsageBindingTarget>;

const parameterNamePattern = /^\/mcp\/(development|test|production)\/access-api\/rest-api-id$/;
const cacheMilliseconds = 300_000;

/**
 * Reads the REST API ID that the gateway stack publishes. The stage stays a deploy input from the
 * provisioning configuration. The value is cached in memory for five minutes; a failed read is not cached,
 * and every failure surfaces as an error so callers fail closed.
 */
export function createRestApiTarget(parameterName: string | undefined, stage: string, client?: SSMClient,
  now: () => number = Date.now): RestApiTargetSource {
  if (!parameterName || !parameterNamePattern.test(parameterName) || !identifierPattern.test(stage)) {
    throw new Error('invalid_rest_api_target_configuration');
  }
  const ssm = client ?? new SSMClient({ maxAttempts: 2 });
  const restApiId = createTtlCache(async (): Promise<string> => {
    const result = await ssm.send(new GetParameterCommand({ Name: parameterName, WithDecryption: false }));
    const value = result.Parameter?.Value;
    if (!value || !identifierPattern.test(value)) throw new Error('invalid_rest_api_target');
    return value;
  }, { ttlMs: cacheMilliseconds, now });
  return async () => ({ rest_api_id: await restApiId(), stage });
}
