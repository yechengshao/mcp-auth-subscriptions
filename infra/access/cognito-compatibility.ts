export interface CognitoCompatibilitySnapshot {
  expected: { user_pool_id: string; client_id: string; domain_prefix: string; callback_uri: string; logout_uri: string };
  observed: {
    pool: { UserPoolId?: string; AdminCreateUserConfig?: { AllowAdminCreateUserOnly?: boolean } };
    client: {
      UserPoolId?: string; ClientId?: string; ClientSecret?: string; GenerateSecret?: boolean;
      AllowedOAuthFlowsUserPoolClient?: boolean; AllowedOAuthFlows?: string[]; AllowedOAuthScopes?: string[];
      SupportedIdentityProviders?: string[]; CallbackURLs?: string[]; LogoutURLs?: string[];
      PreventUserExistenceErrors?: string; EnableTokenRevocation?: boolean;
    };
    domain: { Domain?: string; UserPoolId?: string; Status?: string };
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactSet(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every(value => typeof value === 'string') &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}
function https(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; }
  catch { return false; }
}

/** Compare read-only Cognito Describe* snapshots to the create-mode configuration; output contains no provider data. */
export function checkCognitoCompatibility(input: unknown): { compatible: boolean; mismatches: string[] } {
  if (!record(input) || !record(input.expected) || !record(input.observed) ||
      !record(input.observed.pool) || !record(input.observed.client) || !record(input.observed.domain)) {
    throw new Error('invalid_cognito_compatibility_snapshot');
  }
  const expected = input.expected as CognitoCompatibilitySnapshot['expected'];
  const observed = input.observed as CognitoCompatibilitySnapshot['observed'];
  if (![expected.user_pool_id, expected.client_id, expected.domain_prefix].every(value => typeof value === 'string' && value.length > 0) ||
      !https(expected.callback_uri) || !https(expected.logout_uri)) throw new Error('invalid_cognito_compatibility_snapshot');
  const mismatches: string[] = [];
  const check = (ok: boolean, code: string) => { if (!ok) mismatches.push(code); };
  check(observed.pool.UserPoolId === expected.user_pool_id, 'user_pool_id');
  check(observed.pool.AdminCreateUserConfig?.AllowAdminCreateUserOnly === true, 'admin_only_enrollment');
  check(observed.client.UserPoolId === expected.user_pool_id, 'client_pool');
  check(observed.client.ClientId === expected.client_id, 'client_id');
  check(observed.client.GenerateSecret === false && !observed.client.ClientSecret, 'public_client_no_secret');
  check(observed.client.AllowedOAuthFlowsUserPoolClient === true && exactSet(observed.client.AllowedOAuthFlows, ['code']), 'authorization_code_flow_only');
  check(exactSet(observed.client.AllowedOAuthScopes, ['openid', 'email']), 'oauth_scopes');
  check(exactSet(observed.client.SupportedIdentityProviders, ['COGNITO']), 'identity_providers');
  check(exactSet(observed.client.CallbackURLs, [expected.callback_uri]), 'callback_urls');
  check(exactSet(observed.client.LogoutURLs, [expected.logout_uri]), 'logout_urls');
  check(observed.client.PreventUserExistenceErrors === 'ENABLED', 'user_enumeration_protection');
  check(observed.client.EnableTokenRevocation === true, 'token_revocation');
  check(observed.domain.Domain === expected.domain_prefix && observed.domain.UserPoolId === expected.user_pool_id &&
    observed.domain.Status === 'ACTIVE', 'hosted_login_domain');
  return { compatible: mismatches.length === 0, mismatches };
}
