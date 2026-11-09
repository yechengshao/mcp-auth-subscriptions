/** Access/authorizer entrypoints import these decorators when their business handlers are added. */
export { withHttpTelemetry as withAccessHttpTelemetry, withAuthorizerTelemetry, propagateNative } from '../observability/adapters.js';
export { Telemetry } from '../observability/telemetry.js';
