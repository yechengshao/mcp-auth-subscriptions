# Future Enhancements

Unchecked reminders are outside the current implementation baseline; they do not authorize email, AWS provisioning or payment operations.

## Subscription confirmation email

- [ ] Design and implement one application subscription/setup-confirmation email after verified payment AND successful API Gateway API-key/usage-plan configuration have been conditionally persisted for the current paid term/revision; this associates an API key, not an access token.
- [ ] Include purchased tier, duration, paid-through date, support contact and safe reconnect/management instructions, with an approved verified recipient and no tokens, session cookies, API keys or private claims in content/URLs/logs.
- [ ] Keep Stripe payment receipt and application setup confirmation distinct; configure receipt behavior separately and avoid confusing duplicate messages.
- [ ] Deduplicate notification intent per paid order/term and confirmation type so repeated browser status/resume/reconciliation requests do not resend it; define durable delivery/retry/provider-idempotency handling without charging or repeating provisioning.
- [ ] Do not block OAuth completion/token issuance on email failure, roll back payment or invite repurchase; retain delivery status and retry safely under the future approved notification design.
- [ ] Verify wording and a test-mode end-to-end scenario: successful configuration follows the current success-response rule, not a global propagation probe. Email must not guarantee immediate API Gateway propagation or say ChatGPT is already connected before its code/token exchange finishes; explain reconnect/retry if needed.
- [ ] Test failed setup (no success email), duplicate setup/webhooks, invalid/unverified recipient, email timeout/duplicate delivery, closed-browser activation pause, later reconnect and notification replay without secret disclosure.

**Status**: not implemented, not tested, no email provider chosen and no message sent. First choose provider, sender/recipient verification, privacy/retention, notification permissions and cost/retry limits; do not introduce a new function/table/queue implicitly. Existing request-driven activation remains unchanged: closing the browser pauses setup, so this future email is not guaranteed until a valid request completes configuration. Support terms and manual renewal policies remain authoritative in the existing contracts.
