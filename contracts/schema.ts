/** Shared closed-schema primitives used by independently deployable services. */
import termSchema from '../specs/003-billing-subscriptions/contracts/service-term.schema.json' with { type: 'json' };
import { Ajv2020 } from 'ajv/dist/2020.js';

export type Schema = Record<string, unknown>;
export const text: Schema = { type: 'string', minLength: 1, maxLength: 2048 };
export const id: Schema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' };
export const epoch: Schema = { type: 'integer', minimum: 0, maximum: 253402300799 };
export const integer: Schema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
export const positive: Schema = { ...integer, minimum: 1 };
export const digest: Schema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
export const boolean: Schema = { type: 'boolean' };
export const constant = (value: string | number | boolean): Schema => ({ const: value });
export const choice = (...values: string[]): Schema => ({ enum: values });
export const object = (properties: Record<string, Schema>, optional: string[] = []): Schema => ({
  type: 'object', additionalProperties: false, properties,
  required: Object.keys(properties).filter(key => !optional.includes(key)),
});
export const correlation: Schema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' };
export const traceContext = object({ 'x-amzn-trace-id': { type: 'string', minLength: 1, maxLength: 512 } });
export const identity = object({ issuer: { ...text, pattern: '^https://' }, subject: text });
export const mapping = object({ usage_plan_id: id, rest_api_id: id, stage: id });
export const term: Schema = termSchema;
export const row = { PK: text, SK: text, schema_version: constant(1), entity_type: text, revision: integer };

const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: false });
ajv.addSchema(termSchema);
export function compile(schema: Schema): (input: unknown) => void {
  const validate = ajv.compile(schema);
  return input => {
    if (!validate(input)) throw new Error('invalid_contract'); // Never echo credentials or record values.
  };
}
