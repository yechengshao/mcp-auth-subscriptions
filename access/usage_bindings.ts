import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonicalJson } from '../contracts/canonical.js';
import { validateEntitlement } from '../contracts/entitlement.js';
import { identityPartition } from '../contracts/identity.js';
import { identifierPattern, usageIdentifierKeyPattern } from '../contracts/patterns.js';
import type { AccessRow, StateKey } from './model.js';
import type { Telemetry } from '../observability/telemetry.js';

export interface UsageBindingStore {
  readonly environment: string;
  get(key: StateKey): Promise<AccessRow | undefined>;
  entitlement(identity: { issuer: string; subject: string }): Promise<AccessRow | undefined>;
  commit(writes: Array<{ row: AccessRow; expectedRevision?: number }>, checks?: Array<{
    key: StateKey; expectedRevision?: number; projection?: boolean;
  }>): Promise<void>;
}

export interface ApiGatewayUsagePlanPort {
  createApiKey(input: { name: string; value: string }): Promise<{ apiKeyId: string }>;
  findApiKey(input: { name: string; value: string }): Promise<{ apiKeyId: string } | undefined>;
  associateApiKey(input: { usagePlanId: string; apiKeyId: string }): Promise<void>;
  removeApiKeyAssociation(input: { usagePlanId: string; apiKeyId: string }): Promise<void>;
  hasAssociation(input: { usagePlanId: string; apiKeyId: string }): Promise<boolean>;
  listAssociations(input: { apiKeyId: string }): Promise<Array<{ usage_plan_id: string; rest_api_id: string; stage: string }>>;
}

export type ProvisioningFailureCode = 'not_eligible' | 'activation_pending' | 'activation_retry' |
  'activation_support_required' | 'usage_plan_mismatch' | 'plan_change_requires_reconciliation';
export class ProvisioningFailure extends Error {
  constructor(readonly code: ProvisioningFailureCode, readonly retryable: boolean) { super(code); }
}

export interface UsageBindingResult {
  state: 'configured';
  subscriberId: string;
  entitlementRevision: number;
  apiKeyId: string;
  apiKeyValue: string;
  usageMapping: { usage_plan_id: string; rest_api_id: string; stage: string };
}

export interface ProvisioningOptions {
  maxAttempts: number;
  leaseSeconds: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  provisioningBudgetMs: number;
  sdkTimeoutMs: number;
}
export interface UsageBindingTarget { rest_api_id: string; stage: string }

const defaultOptions: ProvisioningOptions = { maxAttempts: 5, leaseSeconds: 60, backoffMinMs: 2_000, backoffMaxMs: 30_000,
  provisioningBudgetMs: 10_000, sdkTimeoutMs: 3_000 };
const bindingKey = (environment: string, subscriberId: string, restApiId: string, stage: string): StateKey => ({
  PK: `ENV#${environment}#SUBSCRIBER#${subscriberId}`, SK: `REST#${restApiId}#STAGE#${stage}`,
});
const mappingOf = (row: AccessRow) => row.usage_mapping as { usage_plan_id: string; rest_api_id: string; stage: string };
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function candidateKey(): string { return randomBytes(32).toString('hex'); }
function bindingName(environment: string, operationId: string): string { return `mcp-${environment}-${operationId}`; }
function cleanError(row: AccessRow) { const { error_class: _error, ...rest } = row; return rest; }

/**
 * Request-driven, idempotent provisioning of a subscriber API key. All external
 * calls are fenced by persisted state; an uncertain mutation is reconciled by exact
 * candidate key/plan before another request is attempted.
 */
export class UsageBindingProvisioner {
  private readonly options: ProvisioningOptions;
  constructor(private readonly store: UsageBindingStore, private readonly gateway: ApiGatewayUsagePlanPort,
    private readonly telemetry: Telemetry, private readonly target: UsageBindingTarget, options: Partial<ProvisioningOptions> = {},
    private readonly now = () => Math.floor(Date.now() / 1000), private readonly random = Math.random) {
    this.options = { ...defaultOptions, ...options };
    if (!Number.isInteger(this.options.maxAttempts) || this.options.maxAttempts < 1 ||
        !Number.isInteger(this.options.leaseSeconds) || this.options.leaseSeconds < 1 ||
        !Number.isInteger(this.options.backoffMinMs) || this.options.backoffMinMs < 1 ||
        this.options.backoffMaxMs < this.options.backoffMinMs || this.options.backoffMaxMs > 30_000 ||
        !Number.isInteger(this.options.provisioningBudgetMs) || !Number.isInteger(this.options.sdkTimeoutMs) ||
        this.options.provisioningBudgetMs <= this.options.sdkTimeoutMs) {
      throw new Error('invalid_provisioning_options');
    }
  }

  async ensure(input: { identity: { issuer: string; subject: string }; subscriberId: string; invocationId?: string }): Promise<UsageBindingResult> {
    const startedAt = performance.now();
    if (!identifierPattern.test(input.subscriberId)) throw new ProvisioningFailure('not_eligible', false);
    const now = this.now();
    const entitlement = await this.store.entitlement(input.identity);
    try { validateEntitlement(entitlement, this.store.environment, input.identity.issuer, input.identity.subject, now); }
    catch { throw new ProvisioningFailure('not_eligible', false); }
    if (!entitlement || entitlement.revision === undefined) throw new ProvisioningFailure('not_eligible', false);
    const target = entitlement.usage_mapping as { usage_plan_id: string; rest_api_id: string; stage: string };
    if (!identifierPattern.test(target.usage_plan_id) || !identifierPattern.test(target.rest_api_id) || !identifierPattern.test(target.stage) ||
        target.rest_api_id !== this.target.rest_api_id || target.stage !== this.target.stage) {
      throw new ProvisioningFailure('usage_plan_mismatch', false);
    }
    const key = bindingKey(this.store.environment, input.subscriberId, target.rest_api_id, target.stage);
    const invocationId = input.invocationId ?? randomUUID();
    if (!identifierPattern.test(invocationId)) throw new ProvisioningFailure('activation_support_required', false);

    let binding = await this.store.get(key);
    if (!binding) {
      const operationId = randomUUID();
      const proposed: AccessRow = {
        ...key, schema_version: 1, entity_type: 'subscriber_binding', revision: 1,
        environment: this.store.environment, subscriber_id: input.subscriberId,
        plan_id: entitlement.plan_id, duration_option_id: entitlement.duration_option_id,
        catalog_version: entitlement.catalog_version, entitlement_revision: entitlement.revision,
        usage_mapping: target, state: 'pending', operation_id: operationId,
        api_key_value: candidateKey(), attempts: 0, next_attempt_at: now,
        lease_owner: invocationId, fence: 1, lease_until: now + this.options.leaseSeconds,
        mutation: { generation: 1, desired_entitlement_revision: entitlement.revision, status: 'idle' }, updated_at: now,
      };
      try {
        await this.write(proposed, undefined, input.identity, entitlement.revision);
        binding = proposed;
      } catch (error) {
        if (!this.isConflict(error)) throw error;
        binding = await this.store.get(key);
        if (!binding) throw new ProvisioningFailure('activation_retry', true);
      }
    }

    if (binding.entity_type !== 'subscriber_binding' || binding.subscriber_id !== input.subscriberId) {
      throw new ProvisioningFailure('activation_support_required', false);
    }
    if (binding.state === 'configured' && binding.entitlement_revision === entitlement.revision &&
        binding.plan_id === entitlement.plan_id && binding.duration_option_id === entitlement.duration_option_id &&
        binding.catalog_version === entitlement.catalog_version && same(mappingOf(binding), target)) {
      return this.ready(binding);
    }
    if (binding.state === 'configured' && same(mappingOf(binding), target)) {
      const refreshed: AccessRow = { ...cleanError(binding), plan_id: entitlement.plan_id,
        duration_option_id: entitlement.duration_option_id, catalog_version: entitlement.catalog_version,
        entitlement_revision: entitlement.revision,
        mutation: { generation: binding.mutation.generation, desired_entitlement_revision: entitlement.revision, status: 'idle' },
        lease_until: now, updated_at: now, revision: binding.revision + 1 };
      try {
        await this.write(refreshed, binding.revision, input.identity, entitlement.revision);
        return this.ready(refreshed);
      } catch (error) {
        if (!this.isConflict(error)) throw error;
        const winner = await this.store.get(key);
        if (winner?.state === 'configured' && winner.entitlement_revision === entitlement.revision && same(mappingOf(winner), target)) return this.ready(winner);
        throw new ProvisioningFailure('activation_pending', true);
      }
    }
    if (binding.state !== 'configured' && same(mappingOf(binding), target) &&
        ['idle', 'acknowledged'].includes(binding.mutation.status) &&
        binding.mutation.desired_entitlement_revision !== entitlement.revision) {
      const rebased: AccessRow = { ...cleanError(binding), plan_id: entitlement.plan_id,
        duration_option_id: entitlement.duration_option_id, catalog_version: entitlement.catalog_version,
        entitlement_revision: entitlement.revision,
        mutation: { ...binding.mutation, desired_entitlement_revision: entitlement.revision },
        updated_at: now, revision: binding.revision + 1 };
      try {
        await this.write(rebased, binding.revision, input.identity, entitlement.revision);
        binding = rebased;
      } catch (error) {
        if (this.isConflict(error)) throw new ProvisioningFailure('activation_pending', true);
        throw error;
      }
    }
    const mappingChanged = !same(mappingOf(binding), target);
    if (mappingChanged && (!binding.api_key_id || (binding.state !== 'configured' &&
        !['remove_association', 'add_association'].includes(binding.mutation.step)))) {
      throw new ProvisioningFailure('plan_change_requires_reconciliation', true);
    }

    const lease = await this.claim(binding, input.identity, entitlement, invocationId, now);
    if (!lease) throw new ProvisioningFailure('activation_pending', true);
    binding = lease;

    if (binding.mutation.status === 'repair_required') throw new ProvisioningFailure('activation_support_required', false);

    if (binding.mutation.status === 'dispatching' || binding.mutation.status === 'uncertain') {
      binding = await this.reconcile(binding, input.identity, entitlement, invocationId, now, startedAt);
      if (binding.state === 'configured' && binding.entitlement_revision === entitlement.revision) return this.ready(binding);
      if (binding.state === 'error') throw this.failureFor(binding);
    }

    if (mappingChanged || (binding.api_key_id && binding.mutation.step === 'remove_association')) {
      binding = await this.moveAssociation(binding, input.identity, entitlement, invocationId, now, startedAt);
      if (binding.state === 'configured' && binding.entitlement_revision === entitlement.revision) return this.ready(binding);
    }

    if (binding.mutation.status === 'idle' || (binding.mutation.status === 'acknowledged' && binding.mutation.step === 'create_key')) {
      if (!binding.api_key_id) binding = await this.createKey(binding, input.identity, entitlement, invocationId, now, startedAt);
    }
    if (binding.api_key_id && binding.state !== 'configured') {
      binding = await this.associate(binding, input.identity, entitlement, invocationId, now, startedAt);
    }
    if (binding.state !== 'configured' || binding.entitlement_revision !== entitlement.revision) {
      throw new ProvisioningFailure('activation_retry', true);
    }
    this.telemetry.log('transition', 'http.status', 'binding_configured');
    this.telemetry.metric('AccessProvisioningAttemptLatencyMs', performance.now() - startedAt);
    return this.ready(binding);
  }

  private ready(row: AccessRow): UsageBindingResult {
    if (typeof row.api_key_id !== 'string' || typeof row.api_key_value !== 'string' || !usageIdentifierKeyPattern.test(row.api_key_value)) {
      throw new ProvisioningFailure('activation_support_required', false);
    }
    return { state: 'configured', subscriberId: row.subscriber_id, entitlementRevision: row.entitlement_revision,
      apiKeyId: row.api_key_id, apiKeyValue: row.api_key_value, usageMapping: mappingOf(row) };
  }

  private async claim(row: AccessRow, identity: { issuer: string; subject: string }, entitlement: AccessRow,
    owner: string, now: number): Promise<AccessRow | undefined> {
    if (row.lease_until > now && row.lease_owner !== owner) return undefined;
    if (row.state === 'error' && row.error_class === 'configuration_error') throw this.failureFor(row);
    if (row.attempts >= this.options.maxAttempts && row.next_attempt_at <= now) throw new ProvisioningFailure('activation_support_required', false);
    if (row.next_attempt_at > now) throw new ProvisioningFailure('activation_pending', true);
    const claimed = cleanError({ ...row, lease_owner: owner, fence: row.fence + 1,
      lease_until: now + this.options.leaseSeconds, updated_at: now, revision: row.revision + 1 });
    try { await this.write(claimed, row.revision, identity, entitlement.revision); return claimed; }
    catch (error) { if (this.isConflict(error)) return undefined; throw error; }
  }

  private async createKey(row: AccessRow, identity: { issuer: string; subject: string }, entitlement: AccessRow,
    owner: string, now: number, startedAt: number): Promise<AccessRow> {
    await this.beforeGateway(row, identity, now, startedAt);
    const dispatch = this.dispatch(row, 'create_key', row.usage_mapping, owner, now);
    await this.persistDispatch(row, dispatch, identity, entitlement.revision, now);
    if (!this.hasBudget(startedAt)) return this.cancelDispatch(row, dispatch, identity, now);
    try {
      const key = await this.gateway.createApiKey({ name: bindingName(this.store.environment, row.operation_id), value: row.api_key_value });
      if (!identifierPattern.test(key.apiKeyId)) throw new Error('invalid_gateway_response');
      const acknowledged = { ...dispatch, api_key_id: key.apiKeyId, state: 'pending', mutation: {
        ...dispatch.mutation, status: 'acknowledged', api_key_id: key.apiKeyId, evidence: 'accepted' }, revision: dispatch.revision + 1, updated_at: now };
      await this.write(acknowledged, dispatch.revision, identity);
      return acknowledged;
    } catch (error) {
      return this.recordFailure(dispatch, identity, error, now);
    }
  }

  private async associate(row: AccessRow, identity: { issuer: string; subject: string }, entitlement: AccessRow,
    owner: string, now: number, startedAt: number): Promise<AccessRow> {
    await this.beforeGateway(row, identity, now, startedAt);
    const mapping = entitlement.usage_mapping;
    const dispatch = this.dispatch(row, 'add_association', mapping, owner, now, entitlement.revision);
    await this.persistDispatch(row, dispatch, identity, entitlement.revision, now);
    if (!this.hasBudget(startedAt)) return this.cancelDispatch(row, dispatch, identity, now);
    try {
      await this.gateway.associateApiKey({ usagePlanId: mapping.usage_plan_id, apiKeyId: row.api_key_id });
      const acknowledged = { ...dispatch, plan_id: entitlement.plan_id,
        duration_option_id: entitlement.duration_option_id, catalog_version: entitlement.catalog_version,
        entitlement_revision: entitlement.revision, usage_mapping: mapping, state: 'configured',
        mutation: { ...dispatch.mutation, status: 'acknowledged', api_key_id: row.api_key_id, evidence: 'accepted' },
        lease_until: now, revision: dispatch.revision + 1, updated_at: now };
      await this.write(acknowledged, dispatch.revision, identity, entitlement.revision);
      return acknowledged;
    } catch (error) {
      return this.recordFailure(dispatch, identity, error, now);
    }
  }

  private async moveAssociation(row: AccessRow, identity: { issuer: string; subject: string }, entitlement: AccessRow,
    owner: string, now: number, startedAt: number): Promise<AccessRow> {
    let current = row;
    const mutation = current.mutation;
    if (current.state === 'configured' || (mutation.desired_entitlement_revision !== entitlement.revision &&
        ['idle', 'acknowledged'].includes(mutation.status))) {
      const started: AccessRow = { ...cleanError(current), state: 'pending',
        mutation: { generation: mutation.generation + 1, desired_entitlement_revision: entitlement.revision, status: 'idle' },
        revision: current.revision + 1, updated_at: now };
      await this.persistDispatch(current, started, identity, entitlement.revision, now);
      current = started;
    }

    const target = entitlement.usage_mapping as { usage_plan_id: string; rest_api_id: string; stage: string };
    await this.beforeGateway(current, identity, now, startedAt);
    let associations: Array<{ usage_plan_id: string; rest_api_id: string; stage: string }>;
    try { associations = await this.gateway.listAssociations({ apiKeyId: current.api_key_id }); }
    catch (error) { return this.recordReadFailure(current, identity, error, now); }
    const stageAssociations = associations.filter(value => value.rest_api_id === target.rest_api_id && value.stage === target.stage);
    const previous = stageAssociations.find(value => value.usage_plan_id !== target.usage_plan_id);
    if (previous) {
      await this.beforeGateway(current, identity, now, startedAt);
      const dispatch = this.dispatch(current, 'remove_association', previous, owner, now, entitlement.revision);
      await this.persistDispatch(current, dispatch, identity, entitlement.revision, now);
      if (!this.hasBudget(startedAt)) return this.cancelDispatch(current, dispatch, identity, now);
      try {
        await this.gateway.removeApiKeyAssociation({ usagePlanId: previous.usage_plan_id, apiKeyId: current.api_key_id });
      } catch (error) { return this.recordFailure(dispatch, identity, error, now); }
      const acknowledged = { ...dispatch, state: 'pending', mutation: { ...dispatch.mutation,
        status: 'acknowledged', api_key_id: current.api_key_id, evidence: 'closed' },
        revision: dispatch.revision + 1, updated_at: now };
      await this.write(acknowledged, dispatch.revision, identity);
      return this.moveAssociation(acknowledged, identity, entitlement, owner, now, startedAt);
    }

    if (stageAssociations.some(value => value.usage_plan_id === target.usage_plan_id)) {
      const configured: AccessRow = { ...cleanError(current), plan_id: entitlement.plan_id,
        duration_option_id: entitlement.duration_option_id, catalog_version: entitlement.catalog_version,
        entitlement_revision: entitlement.revision, usage_mapping: target, state: 'configured', lease_until: now,
        mutation: { generation: current.mutation.generation, desired_entitlement_revision: entitlement.revision,
          status: 'acknowledged', step: 'add_association', target, owner_invocation_id: owner,
          step_started_at: now, api_key_id: current.api_key_id, evidence: 'accepted' },
        revision: current.revision + 1, updated_at: now };
      try { await this.write(configured, current.revision, identity, entitlement.revision); }
      catch (error) {
        if (this.isConflict(error)) throw new ProvisioningFailure('activation_pending', true);
        throw error;
      }
      return configured;
    }
    return this.associate(current, identity, entitlement, owner, now, startedAt);
  }

  private dispatch(row: AccessRow, step: 'create_key' | 'remove_association' | 'add_association', target: unknown,
    owner: string, now: number, desiredRevision = row.entitlement_revision): AccessRow {
    return { ...cleanError(row), state: 'pending', attempts: row.attempts + 1,
      mutation: { generation: row.mutation.generation, desired_entitlement_revision: desiredRevision,
        status: 'dispatching', step, target, owner_invocation_id: owner,
        step_started_at: now, ...(row.api_key_id ? { api_key_id: row.api_key_id } : {}) },
      revision: row.revision + 1, updated_at: now };
  }

  private async persistDispatch(row: AccessRow, dispatch: AccessRow, identity: { issuer: string; subject: string },
    entitlementRevision: number, now: number): Promise<void> {
    try { await this.write(dispatch, row.revision, identity, entitlementRevision); }
    catch (error) {
      if (!this.isConflict(error)) throw error;
      const released = { ...row, lease_until: now, updated_at: now, revision: row.revision + 1 };
      try { await this.write(released, row.revision, identity); } catch { /* Another owner won; its conditional state is authoritative. */ }
      throw new ProvisioningFailure('activation_pending', true);
    }
  }

  private async beforeGateway(row: AccessRow, identity: { issuer: string; subject: string }, now: number, startedAt: number): Promise<void> {
    if (this.hasBudget(startedAt)) return;
    const released = { ...row, lease_until: now, updated_at: now, revision: row.revision + 1 };
    try { await this.write(released, row.revision, identity); } catch { /* The latest conditional state belongs to another caller. */ }
    throw new ProvisioningFailure('activation_pending', true);
  }

  private hasBudget(startedAt: number): boolean {
    return performance.now() - startedAt + this.options.sdkTimeoutMs < this.options.provisioningBudgetMs;
  }

  private async cancelDispatch(row: AccessRow, dispatch: AccessRow, identity: { issuer: string; subject: string }, now: number): Promise<never> {
    const cancelled = { ...row, lease_until: now, updated_at: now, revision: dispatch.revision + 1 };
    await this.write(cancelled, dispatch.revision, identity);
    throw new ProvisioningFailure('activation_pending', true);
  }

  private async reconcile(row: AccessRow, identity: { issuer: string; subject: string }, entitlement: AccessRow,
    owner: string, now: number, startedAt: number): Promise<AccessRow> {
    const mutation = row.mutation;
    if (mutation.owner_invocation_id === owner) return row;
    try {
      if (mutation.step === 'create_key') {
        await this.beforeGateway(row, identity, now, startedAt);
        const key = await this.gateway.findApiKey({ name: bindingName(this.store.environment, row.operation_id), value: row.api_key_value });
        if (!key) return this.recordUncertain(row, identity, now);
        const reconciled = { ...row, api_key_id: key.apiKeyId, state: 'pending', mutation: {
          ...mutation, status: 'acknowledged', api_key_id: key.apiKeyId, evidence: 'accepted', owner_invocation_id: owner },
          revision: row.revision + 1, updated_at: now };
        await this.write(reconciled, row.revision, identity);
        return reconciled;
      }
      if (mutation.step === 'add_association' && row.api_key_id) {
        await this.beforeGateway(row, identity, now, startedAt);
        const target = mutation.target as { usage_plan_id: string; rest_api_id: string; stage: string };
        if (!same(target, entitlement.usage_mapping)) return this.recordUncertain(row, identity, now);
        const exists = await this.gateway.hasAssociation({ usagePlanId: target.usage_plan_id, apiKeyId: row.api_key_id });
        if (!exists) return this.recordUncertain(row, identity, now);
        const acknowledged = { ...row, plan_id: entitlement.plan_id, duration_option_id: entitlement.duration_option_id,
          catalog_version: entitlement.catalog_version, entitlement_revision: entitlement.revision,
          usage_mapping: target, state: 'configured', mutation: { ...mutation, status: 'acknowledged',
            api_key_id: row.api_key_id, evidence: 'accepted', owner_invocation_id: owner }, revision: row.revision + 1, updated_at: now };
        await this.write(acknowledged, row.revision, identity, entitlement.revision);
        return acknowledged;
      }
      if (mutation.step === 'remove_association' && row.api_key_id) {
        await this.beforeGateway(row, identity, now, startedAt);
        const source = mutation.target as { usage_plan_id: string; rest_api_id: string; stage: string };
        if (same(source, entitlement.usage_mapping)) return this.recordUncertain(row, identity, now);
        const associations = await this.gateway.listAssociations({ apiKeyId: row.api_key_id });
        const stillPresent = associations.some(value => value.usage_plan_id === source.usage_plan_id &&
          value.rest_api_id === source.rest_api_id && value.stage === source.stage);
        if (stillPresent) return this.recordUncertain(row, identity, now);
        const acknowledged = { ...row, state: 'pending', mutation: { ...mutation, status: 'acknowledged',
          api_key_id: row.api_key_id, evidence: 'closed', owner_invocation_id: owner }, revision: row.revision + 1, updated_at: now };
        await this.write(acknowledged, row.revision, identity);
        return acknowledged;
      }
      return this.recordUncertain(row, identity, now);
    } catch (error) {
      if (error instanceof ProvisioningFailure) throw error;
      return this.recordUncertain(row, identity, now);
    }
  }

  private async recordUncertain(row: AccessRow, identity: { issuer: string; subject: string }, now: number): Promise<AccessRow> {
    const uncertain = { ...row, state: 'error', error_class: 'uncertain_effect', mutation: {
      ...row.mutation, status: 'repair_required', evidence: 'unknown' },
      next_attempt_at: now + 30, lease_until: now, updated_at: now, revision: row.revision + 1 };
    await this.write(uncertain, row.revision, identity);
    throw new ProvisioningFailure('activation_support_required', false);
  }

  private async recordFailure(row: AccessRow, identity: { issuer: string; subject: string }, error: unknown, now: number): Promise<AccessRow> {
    const kind = (error as { kind?: string })?.kind;
    const uncertain = kind === 'uncertain' || kind === undefined;
    const permanent = kind === 'configuration';
    const attempts = row.attempts;
    const ceiling = Math.min(this.options.backoffMinMs * (2 ** Math.max(attempts - 1, 0)), this.options.backoffMaxMs);
    const jitter = Math.floor(ceiling * (0.5 + Math.min(Math.max(this.random(), 0), 1) * 0.5));
    const failed: AccessRow = { ...row, state: 'error', attempts, next_attempt_at: now + Math.ceil(jitter / 1000), lease_until: now,
      error_class: uncertain ? 'uncertain_effect' : permanent ? 'configuration_error' : 'dependency_unavailable',
      mutation: { ...row.mutation, status: uncertain ? 'uncertain' : 'idle', evidence: uncertain ? 'unknown' : 'closed' },
      updated_at: now, revision: row.revision + 1 };
    await this.write(failed, row.revision, identity);
    this.telemetry.metric('AccessProvisioningFailureCount', 1);
    this.telemetry.log('error', 'http.status', 'server_error', { status_code: permanent ? 500 : 503, error });
    if (uncertain) throw new ProvisioningFailure('activation_support_required', false);
    if (permanent) throw new ProvisioningFailure('activation_support_required', false);
    throw new ProvisioningFailure(attempts >= this.options.maxAttempts ? 'activation_support_required' : 'activation_retry', attempts < this.options.maxAttempts);
  }

  private async recordReadFailure(row: AccessRow, identity: { issuer: string; subject: string }, error: unknown, now: number): Promise<never> {
    const permanent = (error as { kind?: string })?.kind === 'configuration';
    const failed: AccessRow = { ...row, state: 'error', error_class: permanent ? 'configuration_error' : 'dependency_unavailable',
      next_attempt_at: now + 2, lease_until: now, updated_at: now, revision: row.revision + 1 };
    await this.write(failed, row.revision, identity);
    this.telemetry.metric('AccessProvisioningFailureCount', 1);
    this.telemetry.log('error', 'http.status', 'server_error', { status_code: permanent ? 500 : 503, error });
    throw new ProvisioningFailure(permanent ? 'activation_support_required' : 'activation_retry', !permanent);
  }

  private failureFor(row: AccessRow): ProvisioningFailure {
    return row.error_class === 'uncertain_effect' ? new ProvisioningFailure('activation_support_required', false) :
      row.error_class === 'configuration_error' || row.error_class === 'exhausted' ? new ProvisioningFailure('activation_support_required', false) :
      new ProvisioningFailure('activation_retry', true);
  }

  private async write(row: AccessRow, expectedRevision: number | undefined, identity: { issuer: string; subject: string },
    expectedEntitlementRevision?: number): Promise<void> {
    const writes = [{ row, ...(expectedRevision === undefined ? {} : { expectedRevision }) }];
    const checks = expectedEntitlementRevision === undefined ? [] : [{
      key: { PK: identityPartition(this.store.environment, identity.issuer, identity.subject), SK: 'ENTITLEMENT' },
      expectedRevision: expectedEntitlementRevision, projection: true,
    }];
    await this.store.commit(writes, checks);
  }

  private isConflict(error: unknown): boolean {
    return error instanceof Error && ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(error.name);
  }
}
