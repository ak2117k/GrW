/**
 * Test stub for `otplib` (TDA-007 subscription.spec).
 *
 * The real `otplib` v13 pulls in the ESM-only `@scure/base` package, which this
 * suite's ts-jest transform does not process (node_modules is ignored). These
 * inert named exports keep any transitive MfaService import resolvable without
 * loading any ESM. MFA is never exercised by these tests.
 */
module.exports = {
  generateSecret: () => 'STUB_SECRET',
  generateURI: () => 'otpauth://totp/stub',
  verify: async () => false,
};
