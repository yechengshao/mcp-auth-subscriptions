# Service-token REQUEST authorizer

`handler.ts` is the Lambda entrypoint for a managed Node.js 24.x ARM64 runtime.
`npm run package:authorizer` compiles the TypeScript modules and creates a ZIP
containing only the handler, its shared security/observability modules, and the
locked `jose` runtime dependency. It emits SHA-256 release evidence beside the ZIP.

The handler has no state, signing-key, billing, provisioning, Stripe or MCP
dependency. It verifies RS256 service access JWTs and returns an exact REST method
policy; `usageIdentifierKey` appears only at the response top level on Allow.

[Configuration and deployment](../docs/access-implementation.md) describe the
immutable S3 ZIP artifact, Lambda template and release renderer. Root
`npm run check` includes a hermetic smoke test against an extracted package. No
deployment or publication has run.
