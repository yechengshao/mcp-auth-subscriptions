/** Shared primitive formats. Keep these dependency-free so small Lambda packages can reuse them. */
export const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/;
export const sha256HexPattern = /^[a-f0-9]{64}$/;
export const correlationIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const s256ChallengePattern = /^[A-Za-z0-9_-]{43}$/;
export const usageIdentifierKeyPattern = /^[A-Za-z0-9]{20,128}$/;
export const awsAccountIdPattern = /^[0-9]{12}$/;
export const registeredClientIdPattern = /^[\x21-\x7e]{1,256}$/;
