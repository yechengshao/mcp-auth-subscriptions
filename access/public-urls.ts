import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { Telemetry } from '../observability/telemetry.js';

export interface PublicUrlParameterNames { issuer: string; resource: string }

const issuerName = /^\/mcp\/(development|test|production)\/access\/issuer-url$/;
const resourceName = /^\/mcp\/(development|test|production)\/access\/resource-url$/;

/**
 * Reads the public issuer and MCP resource URLs published by infra/access/public-urls.yaml. A placeholder value
 * (UNSET) or a missing parameter refuses the startup; the URL itself is validated as HTTPS by the access configuration.
 */
export async function readPublicUrls(names: PublicUrlParameterNames, telemetry: Telemetry,
  ssm = new SSMClient({ maxAttempts: 2, requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 } })): Promise<{ issuer: string; resource: string }> {
  if (!issuerName.test(names.issuer) || !resourceName.test(names.resource)) throw new Error('invalid_public_url_parameter_configuration');
  const read = async (name: string): Promise<string> => {
    const response = await telemetry.dependency('ssm.catalog', () => ssm.send(new GetParameterCommand({ Name: name, WithDecryption: false }), { abortSignal: AbortSignal.timeout(3000) }));
    const value = response.Parameter?.Value;
    if (response.Parameter?.Type !== 'String' || !value || value === 'UNSET') throw new Error('access_public_url_unset');
    return value;
  };
  const [issuer, resource] = await Promise.all([read(names.issuer), read(names.resource)]);
  return { issuer, resource };
}
