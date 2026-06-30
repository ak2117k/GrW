/**
 * Test stub for `otplib` (carried over from TDA-003 harness).
 *
 * The real `otplib` v13 pulls in the ESM-only `@scure/base` package, which this
 * suite's ts-jest transform does not process (node_modules is ignored). The
 * RBAC regression test imports the REAL AuthModule purely to exercise its GLOBAL
 * GUARD wiring — it never invokes MFA — so we map `otplib` to these inert
 * named exports to keep MfaService importable without loading any ESM.
 */
module.exports = {
  generateSecret: () => 'STUB_SECRET',
  generateURI: () => 'otpauth://totp/stub',
  verify: async () => false,
};
