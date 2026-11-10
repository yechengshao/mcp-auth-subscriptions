# Service-token REQUEST authorizer

`handler.ts` is the real Lambda entrypoint, independently packaged with `jose`.
It has no state, signing-key, billing, provisioning, Stripe or MCP dependency.
It verifies RS256 service access JWTs and returns an exact REST method policy;
usageIdentifierKey appears only at the response top level on Allow.

[Configuration, packaging and remaining gates](../docs/access-implementation.md)
distinguish the local isolated smoke test from unrun final ARM64/native AWS checks.
Use the root `npm run check` for TypeScript and all local contract/security tests.
No deployment or publication has run.
