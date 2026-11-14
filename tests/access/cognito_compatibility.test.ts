import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCognitoCompatibility } from '../../infra/access/cognito-compatibility.js';

const valid = {
  expected: { user_pool_id: 'us-east-1_poolfixture', client_id: 'clientfixture', domain_prefix: 'mcp-auth-test',
    callback_uri: 'https://access.example.invalid/oauth/cognito/callback', logout_uri: 'https://access.example.invalid/logout' },
  observed: {
    pool: { UserPoolId: 'us-east-1_poolfixture', AdminCreateUserConfig: { AllowAdminCreateUserOnly: false } },
    client: { UserPoolId: 'us-east-1_poolfixture', ClientId: 'clientfixture', ClientSecret: undefined as string | undefined, GenerateSecret: false,
      AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthFlows: ['code'], AllowedOAuthScopes: ['email', 'openid'],
      SupportedIdentityProviders: ['COGNITO', 'Google'], CallbackURLs: ['https://access.example.invalid/oauth/cognito/callback'],
      LogoutURLs: ['https://access.example.invalid/logout'], PreventUserExistenceErrors: 'ENABLED', EnableTokenRevocation: true },
    domain: { Domain: 'mcp-auth-test', UserPoolId: 'us-east-1_poolfixture', Status: 'ACTIVE' },
  },
};

test('existing Cognito pool/client/domain reuse requires exact create-mode security configuration', () => {
  assert.deepEqual(checkCognitoCompatibility(valid), { compatible: true, mismatches: [] });
  const cases: Array<[string, (value: typeof valid) => void, string]> = [
    ['pool', value => { value.observed.pool.AdminCreateUserConfig.AllowAdminCreateUserOnly = true; }, 'self_registration_enabled'],
    ['providers', value => { value.observed.client.SupportedIdentityProviders = ['COGNITO', 'Google', 'Facebook']; }, 'identity_providers'],
    ['google_missing', value => { value.observed.client.SupportedIdentityProviders = ['COGNITO']; }, 'identity_providers'],
    ['secret', value => { value.observed.client.GenerateSecret = true; value.observed.client.ClientSecret = 'must-not-be-printed'; }, 'public_client_no_secret'],
    ['flow', value => { value.observed.client.AllowedOAuthFlows = ['code', 'implicit']; }, 'authorization_code_flow_only'],
    ['scope', value => { value.observed.client.AllowedOAuthScopes.push('phone'); }, 'oauth_scopes'],
    ['callback', value => { value.observed.client.CallbackURLs.push('https://other.example.invalid/callback'); }, 'callback_urls'],
    ['logout', value => { value.observed.client.LogoutURLs = []; }, 'logout_urls'],
    ['domain', value => { value.observed.domain.Status = 'CREATING'; }, 'hosted_login_domain'],
  ];
  for (const [name, mutate, expectedMismatch] of cases) {
    const candidate = structuredClone(valid); mutate(candidate);
    const result = checkCognitoCompatibility(candidate);
    assert.equal(result.compatible, false, name);
    assert.ok(result.mismatches.includes(expectedMismatch), name);
    assert.equal(JSON.stringify(result).includes('must-not-be-printed'), false);
  }
});

test('Cognito compatibility snapshot rejects malformed or non-HTTPS expected endpoints', () => {
  assert.throws(() => checkCognitoCompatibility({ ...valid, expected: { ...valid.expected, callback_uri: 'http://insecure.invalid/callback' } }),
    /invalid_cognito_compatibility_snapshot/);
});
