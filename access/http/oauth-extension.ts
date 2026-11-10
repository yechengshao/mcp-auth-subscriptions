import type { AccessTokens } from '../tokens.js';
import type { BrowserSessions } from '../sessions.js';
import type { AccessConfiguration } from '../config.js';
import type { Telemetry } from '../../observability/telemetry.js';
import { createOnboardingHandlers } from './onboarding-handlers.js';
import { createTokenHandlers } from './token-handlers.js';
import type { OAuthExtension } from './types.js';
import type { Onboarding } from '../onboarding.js';
import { Management } from '../management.js';
import { createManagementHandlers } from './management-handlers.js';

/** Complete protocol/browser extension assembled in the Lambda composition root. */
export function createOAuthExtension(input: { config: AccessConfiguration; sessions: BrowserSessions;
  tokens: AccessTokens; onboarding: Onboarding; management: Management; telemetry: Telemetry }): OAuthExtension {
  const oauth = createTokenHandlers(input.tokens, input.telemetry);
  const browser = createOnboardingHandlers(input.config, input.sessions, input.onboarding, input.telemetry);
  const management = createManagementHandlers(input.config, input.sessions, input.management, browser, input.telemetry);
  return { ...oauth, ...browser, ...management };
}
