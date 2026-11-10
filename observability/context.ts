import { randomUUID } from 'node:crypto';
import { correlationIdPattern } from '../contracts/patterns.js';

export interface TraceContext { traceId: string; parentId: string; sampled: boolean }
export const correlationPattern = correlationIdPattern;
export function correlationId(input: unknown): string {
  return typeof input === 'string' && correlationPattern.test(input) ? input : randomUUID();
}
/** Read AWS tracking metadata for correlation only; no SDK, generated spans or exporter. */
export function parseXray(input: unknown): TraceContext | undefined {
  if (typeof input !== 'string' || input.length > 512) return undefined;
  const entries = new Map<string, string>();
  for (const item of input.split(';')) {
    const field = item.trim(), separator = field.indexOf('=');
    if (separator < 0) continue;
    const name = field.slice(0, separator), value = field.slice(separator + 1);
    if (!['Root','Parent','Sampled'].includes(name)) continue;
    if (entries.has(name)) return undefined;
    entries.set(name, value);
  }
  const root = entries.get('Root') ?? '', parent = entries.get('Parent') ?? '', sampled = entries.get('Sampled');
  if (!/^1-[a-f0-9]{8}-[a-f0-9]{24}$/.test(root) || !/^[a-f0-9]{16}$/.test(parent) ||
      !['0','1'].includes(sampled ?? '') || /^0+$/.test(root.slice(2).replace('-', '')) || /^0+$/.test(parent)) return undefined;
  return { traceId: root, parentId: parent, sampled: sampled === '1' };
}
export function xrayHeader(context: TraceContext): string {
  return `Root=${context.traceId};Parent=${context.parentId};Sampled=${context.sampled ? '1' : '0'}`;
}
/** Node Lambda refreshes this reserved value per invocation; never cache it at module load. */
export function lambdaParent(): TraceContext | undefined { return parseXray(process.env._X_AMZN_TRACE_ID); }
export function header(input: unknown, name: string, multiValue?: unknown): string | undefined {
  const matches: string[] = [];
  if (multiValue && typeof multiValue === 'object') {
    for (const [key, values] of Object.entries(multiValue)) {
      if (key.toLowerCase() === name.toLowerCase()) {
        if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string') return undefined;
        matches.push(values[0]);
      }
    }
    if (matches.length) return matches.length === 1 ? matches[0] : undefined;
  }
  if (input && typeof input === 'object') for (const [key, value] of Object.entries(input)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      if (typeof value !== 'string') return undefined;
      matches.push(value);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}
