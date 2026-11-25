import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPublicUrls } from '../../access/public-urls.js';
import { Telemetry } from '../../observability/telemetry.js';

const names = { issuer: '/mcp/test/access/issuer-url', resource: '/mcp/test/access/resource-url' };
const telemetry = () => new Telemetry({ service: 'access', environment: 'test', release: 'fixture' }, { sink: () => undefined });
const fakeSsm = (values: Record<string, string>) => ({ send: async (command: any) => ({ Parameter: { Type: 'String', Value: values[command.input.Name] } }) }) as any;

test('the issuer and resource URLs are read from their SSM parameters', async () => {
  const urls = await readPublicUrls(names, telemetry(), fakeSsm({ [names.issuer]: 'https://access.example.invalid', [names.resource]: 'https://api.example.invalid/mcp' }));
  assert.deepEqual(urls, { issuer: 'https://access.example.invalid', resource: 'https://api.example.invalid/mcp' });
});

test('a placeholder UNSET value refuses startup, and only exact parameter names are accepted', async () => {
  await assert.rejects(readPublicUrls(names, telemetry(), fakeSsm({ [names.issuer]: 'UNSET', [names.resource]: 'https://api.example.invalid/mcp' })), /access_public_url_unset/);
  await assert.rejects(readPublicUrls({ ...names, issuer: '/mcp/test/access/other' }, telemetry(), fakeSsm({})), /invalid_public_url_parameter_configuration/);
});
