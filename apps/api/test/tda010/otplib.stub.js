/**
 * Test stub for `otplib` (TDA-010 DB-backed specs that import the REAL
 * AuthModule / TenantModule chain).
 *
 * The real `otplib` v13 pulls in the ESM-only `@scure/base` package, which this
 * suite's ts-jest transform does not process (node_modules is ignored). Map
 * `otplib` to these inert named exports so MfaService stays importable without
 * loading any ESM. MFA is never exercised by the fan-out tests.
 */
module.exports = {
  generateSecret: () => 'STUB_SECRET',
  generateURI: () => 'otpauth://totp/stub',
  verify: async () => false,
};
