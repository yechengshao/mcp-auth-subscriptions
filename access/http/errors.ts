import type { ErrorRequestHandler } from 'express';
import { endpoint, type AccessConfiguration } from '../config.js';
import { IdentityProviderFailure } from '../ports.js';
import { SessionFailure } from '../sessions.js';
import type { Telemetry } from '../../observability/telemetry.js';

export function accessErrors(config: AccessConfiguration, telemetry: Telemetry): ErrorRequestHandler {
  return (error: unknown, _request, response, _next) => {
    const parserError = error as { type?: unknown };
    if (parserError?.type === 'entity.too.large') { response.status(413).json({ error: 'invalid_request' }); return; }
    if (parserError?.type === 'entity.parse.failed') { response.status(400).json({ error: 'invalid_request' }); return; }
    if (error instanceof SessionFailure) {
      response.status(error.status).json({ error: error.code, ...(error.status === 401 ? { action: endpoint(config, '/login') } : {}) });
      return;
    }
    if (error instanceof IdentityProviderFailure) { response.status(error.status).json({ error: error.message }); return; }
    if (error instanceof Error && ['invalid_request', 'invalid_access_token'].includes(error.message)) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }
    telemetry.log('error', 'http.login', 'unexpected_error', { error });
    response.status(503).set('retry-after', '5').json({ error: 'temporarily_unavailable' });
  };
}
