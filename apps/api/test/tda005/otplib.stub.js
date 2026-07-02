/**
 * Test stub for `otplib` (TDA-005 suite).
 *
 * The real `otplib` v13 pulls in the ESM-only `@scure/base` package, which this
 * suite's ts-jest transform does not process (node_modules is ignored). Specs
 * that import the REAL AuthModule pull in MfaService transitively but never
 * invoke MFA, so we map `otplib` to these inert named exports to keep
 * MfaService importable without loading any ESM.
 */
module.exports = {
  generateSecret: () => 'STUB_SECRET',
  generateURI: () => 'otpauth://totp/stub',
  verify: async () => false,
};
