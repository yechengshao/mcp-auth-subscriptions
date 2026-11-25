import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { identifierPattern } from '../contracts/patterns.js';
import { createTtlCache } from '../contracts/ttl-cache.js';
import type { UsageBindingTarget } from './usage_bindings.js';

/** Resolves the REST API this deployment protects. Each call returns the current target or throws. */
export type RestApiTargetSource = () => Promise<UsageBindingTarget>;

const restApiPattern = /^\/mcp\/(development|test|production)\/access-api\/rest-api-id$/;
const stagePattern = /^\/mcp\/(development|test|production)\/access-api\/stage$/;
const cacheMilliseconds = 300_000;

/**
 * Reads the REST API ID and stage that the gateway stack publishes. Both are read together and cached for five
 * minutes; a failed read is never cached, and every failure surfaces as an error so callers fail closed.
 */
export function createRestApiTarget(restApiName: string | undefined, stageName: string | undefined, client?: SSMClient,
  now: () => number = Date.now): RestApiTargetSource {
  if (!restApiName || !restApiPattern.test(restApiName) || !stageName || !stagePattern.test(stageName)) {
    throw new Error('invalid_rest_api_target_configuration');
  }
  const ssm = client ?? new SSMClient({ maxAttempts: 2 });
  const read = async (name: string): Promise<string> => {
    const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: false }));
    const value = result.Parameter?.Value;
    if (!value || !identifierPattern.test(value)) throw new Error('invalid_rest_api_target');
    return value;
  };
  return createTtlCache(async (): Promise<UsageBindingTarget> => {
    const [rest_api_id, stage] = await Promise.all([read(restApiName), read(stageName)]);
    return { rest_api_id, stage };
  }, { ttlMs: cacheMilliseconds, now });
}
