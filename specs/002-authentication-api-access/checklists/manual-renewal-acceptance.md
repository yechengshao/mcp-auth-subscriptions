# Acceptance Reminder: Expired Subscription and AI-Client Reconnect

**Status**: not_run; run after specs 002/003 implementation, before claiming live host renewal readiness. Track under access T013 and billing B014; local-only fixtures do not complete live acceptance. Repeat independently for ChatGPT and Claude. No deployment, account change, notification or payment is authorized by this checklist.

## Setup

Use an explicitly authorized test environment, Stripe test mode, registered real host client/callback and a verified test identity with an active paid term, working API key/binding and stored client access/refresh credentials. Choose an approved short-lived fixture term or controlled local clock; do not shorten a real customer's subscription. Record original subscriber/key identifiers securely for comparison, never credential values in evidence.

## Scenario and expected results

- [ ] Before expiry, verify MCP works and normal refresh needs no browser login.
- [ ] At/after paid-through, verify access JWT and refresh validity end at their defined bounds even if DynamoDB TTL has not deleted records; no Stripe renewal/off-session charge occurs.
- [ ] Use the AI client again and observe its real refresh request; expired refresh returns OAuth invalid_grant with no new credentials and no token disclosure.
- [ ] Record actual client UI: automatic authorization opening, reconnect/sign-in prompt, recoverable error or a manual reconnection requirement; do not assume an automatic browser redirect.
- [ ] Follow the supported reconnect action; discovery/authorization starts the existing onboarding flow and Cognito verifies the same identity, possibly using an existing browser session.
- [ ] Confirm the expired user sees current approved plan/duration selection, rather than silently receiving paid login or a forced new account.
- [ ] Select a plan/duration, verify displayed amount/catalog version, and complete one explicit test-mode Checkout; repeated browser/reconnect requests reuse pending intent rather than duplicate purchase.
- [ ] Verify signed webhook or delayed billing reconciliation commits the newly paid term and expiry; browser return alone cannot grant access.
- [ ] Verify access reuses the original subscriber identity and API key, configures the correct purchased usage plan if needed, and completes code redirect only after successful AWS configuration/persistence.
- [ ] Verify AI backend exchanges the one-use code with PKCE, stores new tokens, resumes MCP use and can refresh within the new paid term without repeated login.
- [ ] Verify old expired credentials remain unusable; new refresh expiry follows the newly purchased term, not an extension by rotating the old refresh family.
- [ ] Close the browser after payment in a separate run: payment remains recorded, binding setup pauses, and fresh reconnect reuses the confirmed paid term without another Checkout charge.

## Evidence and completion

Record host/product version, test environment, scenario timestamps, sanitized expected/actual outcomes, test-run references and actual reconnect UI behavior. Keep codes, tokens, cookies, verifiers, usage-key values and payment secrets out of logs/screenshots/evidence. A missing reconnect affordance or unusable renewal journey is a host-compatibility failure to resolve/document before release, not an automatic pass because the backend returned invalid_grant. Mark per-host local/live outcomes separately; keep unchecked until executed with evidence.
