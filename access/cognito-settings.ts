import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { validateCognitoConfiguration, type CognitoConfiguration } from './config.js';
import type { Telemetry } from '../observability/telemetry.js';

/**
 * Scopes are code, not configuration. They must equal the Cognito app client's AllowedOAuthScopes in
 * infra/access/auth.yaml; a test checks that they match.
 */
export const cognitoScopes = ['openid', 'email'];

export interface CognitoParameterNames { issuer: string; clientId: string; domain: string; callbackUri: string }

const expected: Record<keyof CognitoParameterNames, RegExp> = {
  issuer: /^\/mcp\/(development|test|production)\/access\/cognito-issuer$/,
  clientId: /^\/mcp\/(development|test|production)\/access\/cognito-client-id$/,
  domain: /^\/mcp\/(development|test|production)\/access\/cognito-domain$/,
  callbackUri: /^\/mcp\/(development|test|production)\/access\/cognito-callback-uri$/,
};

/**
 * Reads the Cognito settings that infra/access/auth.yaml publishes and validates them as one configuration object.
 * Parameters are Standard Strings, so no decryption. Any missing, non-String or malformed value fails the startup.
 */
export async function readCognitoSettings(names: CognitoParameterNames, telemetry: Telemetry,
  ssm = new SSMClient({ maxAttempts: 2, requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 } })): Promise<CognitoConfiguration> {
  for (const key of Object.keys(expected) as Array<keyof CognitoParameterNames>) {
    if (!expected[key].test(names[key])) throw new Error('invalid_cognito_parameter_configuration');
  }
  const read = async (name: string): Promise<string> => {
    const response = await telemetry.dependency('ssm.catalog', () => ssm.send(new GetParameterCommand({ Name: name, WithDecryption: false }), { abortSignal: AbortSignal.timeout(3000) }));
    if (response.Parameter?.Type !== 'String' || !response.Parameter.Value) throw new Error('invalid_cognito_parameter');
    return response.Parameter.Value;
  };
  const [issuer, clientId, domain, callbackUri] = await Promise.all([read(names.issuer), read(names.clientId), read(names.domain), read(names.callbackUri)]);
  return validateCognitoConfiguration({ issuer, domain, clientId, callbackUri, scopes: [...cognitoScopes] });
}
