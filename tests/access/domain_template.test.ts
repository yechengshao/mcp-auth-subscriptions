import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const template = readFileSync('infra/access/domain.yaml', 'utf8');

test('domain template defaults to the access host and keeps the certificate in this region', () => {
  assert.match(template, /DomainName:\n\s+Type: String\n\s+Default: access\.tradingview\.chat\n/);
  assert.match(template, /Certificate:\n\s+Type: AWS::CertificateManager::Certificate/);
  assert.match(template, /ValidationMethod: DNS/);
  assert.match(template, /RegionalCertificateArn: !Ref Certificate/);
});

test('domain template uses a regional API Gateway domain with TLS 1.2 and maps it to the published stage', () => {
  assert.match(template, /Type: AWS::ApiGateway::DomainName/);
  assert.match(template, /Types:\n\s+- REGIONAL/);
  assert.match(template, /SecurityPolicy: TLS_1_2/);
  assert.match(template, /Type: AWS::ApiGateway::BasePathMapping/);
  assert.match(template, /RestApiId: !Ref RestApiId/);
  assert.match(template, /Stage: !Ref RestApiStage/);
  assert.match(template, /RestApiId:\n\s+Type: AWS::SSM::Parameter::Value<String>\n\s+Default: \/mcp\/test\/access-api\/rest-api-id/);
  assert.match(template, /RestApiStage:\n\s+Type: AWS::SSM::Parameter::Value<String>\n\s+Default: \/mcp\/test\/access-api\/stage/);
});

test('domain template writes the alias record into the hosted zone the deploy input names', () => {
  assert.match(template, /Type: AWS::Route53::RecordSet/);
  assert.match(template, /HostedZoneId: !Ref HostedZoneId\n\s+Name: !Ref DomainName\n\s+Type: A/);
  assert.match(template, /DNSName: !GetAtt ApiDomainName\.RegionalDomainName/);
  assert.match(template, /HostedZoneId: !GetAtt ApiDomainName\.RegionalHostedZoneId/);
  assert.match(template, /HostedZoneId:\n\s+Type: String\n\s+AllowedPattern: '\^Z/);
});

test('domain template publishes no secrets and takes no URLs or stage names as deploy inputs beyond the host and zone', () => {
  assert.equal(/Secret|Password|PrivateKey/i.test(template), false);
  assert.equal(template.includes('ACCESS_CONFIG'), false);
});
