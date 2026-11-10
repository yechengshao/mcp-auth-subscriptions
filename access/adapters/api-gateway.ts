import {
  APIGatewayClient, CreateApiKeyCommand, CreateUsagePlanKeyCommand, GetApiKeysCommand, GetUsagePlansCommand,
  DeleteUsagePlanKeyCommand,
} from '@aws-sdk/client-api-gateway';
import type { Telemetry } from '../../observability/telemetry.js';
import type { ApiGatewayUsagePlanPort } from '../usage_bindings.js';

export type ApiGatewayFailureKind = 'dependency' | 'configuration' | 'uncertain';
export class ApiGatewayProvisioningFailure extends Error {
  constructor(readonly kind: ApiGatewayFailureKind) { super('api_gateway_provisioning_failed'); }
}

function failureKind(error: unknown): ApiGatewayFailureKind {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  if (status === 429) return 'dependency';
  if (status === 408 || (status !== undefined && status >= 500)) return 'uncertain';
  if (status !== undefined && status >= 400) return 'configuration';
  return 'uncertain';
}

/** Native API Gateway REST API management adapter; SDK retries are disabled for mutations. */
export class ApiGatewayUsagePlans implements ApiGatewayUsagePlanPort {
  private readonly client: APIGatewayClient;
  constructor(private readonly telemetry: Telemetry, options: { client?: APIGatewayClient; timeoutMs?: number } = {}) {
    const timeoutMs = options.timeoutMs ?? 3_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10_000) throw new Error('invalid_gateway_timeout');
    this.client = options.client ?? new APIGatewayClient({ maxAttempts: 1,
      requestHandler: { requestTimeout: timeoutMs, connectionTimeout: Math.min(timeoutMs, 1_000) } });
  }

  async createApiKey(input: { name: string; value: string }): Promise<{ apiKeyId: string }> {
    try {
      const result = await this.telemetry.dependency('gateway.provision', () => this.client.send(new CreateApiKeyCommand({
        name: input.name, value: input.value, enabled: true,
      })));
      if (!result.id) throw new ApiGatewayProvisioningFailure('uncertain');
      return { apiKeyId: result.id };
    } catch (error) {
      if (failureKind(error) !== 'configuration' || (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode !== 409) {
        if (error instanceof ApiGatewayProvisioningFailure) throw error;
        throw new ApiGatewayProvisioningFailure(failureKind(error));
      }
      // A duplicate value/name response is reconciled by the exact persisted candidate value.
      let existing: { apiKeyId: string } | undefined;
      try { existing = await this.findApiKey(input); }
      catch { throw new ApiGatewayProvisioningFailure('uncertain'); }
      if (existing) return existing;
      throw new ApiGatewayProvisioningFailure('uncertain');
    }
  }

  async findApiKey(input: { name: string; value: string }): Promise<{ apiKeyId: string } | undefined> {
    let position: string | undefined;
    for (let page = 0; page < 10; page++) {
      try {
        const result = await this.telemetry.dependency('gateway.provision', () => this.client.send(new GetApiKeysCommand({
          nameQuery: input.name, includeValues: true, limit: 100, ...(position ? { position } : {}),
        })));
        const found = (result.items ?? []).find(key => key.name === input.name && key.value === input.value && key.id);
        if (found?.id) return { apiKeyId: found.id };
        if (!result.position) return undefined;
        position = result.position;
      } catch (error) { throw new ApiGatewayProvisioningFailure(failureKind(error)); }
    }
    throw new ApiGatewayProvisioningFailure('uncertain');
  }

  async associateApiKey(input: { usagePlanId: string; apiKeyId: string }): Promise<void> {
    try {
      await this.telemetry.dependency('gateway.provision', () => this.client.send(new CreateUsagePlanKeyCommand({
        usagePlanId: input.usagePlanId, keyId: input.apiKeyId, keyType: 'API_KEY',
      })));
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (status === 409) {
        try { if (await this.hasAssociation(input)) return; }
        catch { throw new ApiGatewayProvisioningFailure('uncertain'); }
        throw new ApiGatewayProvisioningFailure('uncertain');
      }
      throw new ApiGatewayProvisioningFailure(failureKind(error));
    }
  }

  async hasAssociation(input: { usagePlanId: string; apiKeyId: string }): Promise<boolean> {
    return (await this.listAssociations({ apiKeyId: input.apiKeyId })).some(plan => plan.usage_plan_id === input.usagePlanId);
  }

  async listAssociations(input: { apiKeyId: string }): Promise<Array<{ usage_plan_id: string; rest_api_id: string; stage: string }>> {
    let position: string | undefined;
    const associations: Array<{ usage_plan_id: string; rest_api_id: string; stage: string }> = [];
    for (let page = 0; page < 10; page++) {
      try {
        const result = await this.telemetry.dependency('gateway.provision', () => this.client.send(new GetUsagePlansCommand({
          keyId: input.apiKeyId, limit: 100, ...(position ? { position } : {}),
        })));
        for (const plan of result.items ?? []) {
          if (!plan.id) continue;
          for (const stage of plan.apiStages ?? []) {
            if (stage.apiId && stage.stage) associations.push({ usage_plan_id: plan.id, rest_api_id: stage.apiId, stage: stage.stage });
          }
        }
        if (!result.position) return associations;
        position = result.position;
      } catch (error) { throw new ApiGatewayProvisioningFailure(failureKind(error)); }
    }
    throw new ApiGatewayProvisioningFailure('uncertain');
  }

  async removeApiKeyAssociation(input: { usagePlanId: string; apiKeyId: string }): Promise<void> {
    try {
      await this.telemetry.dependency('gateway.provision', () => this.client.send(new DeleteUsagePlanKeyCommand({
        usagePlanId: input.usagePlanId, keyId: input.apiKeyId,
      })));
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (status === 404) return;
      throw new ApiGatewayProvisioningFailure(failureKind(error));
    }
  }
}
