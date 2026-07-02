/**
 * Test stub for `otplib` (TDA-009, copied from tda008/tda007).
 *
 * The real `otplib` v13 pulls in the ESM-only `@scure/base` package, which this
 * suite's ts-jest transform does not process (node_modules is ignored). The
 * consent endpoint test imports the REAL AuthModule purely to exercise its
 * GLOBAL GUARD wiring — it never invokes MFA — so we map `otplib` to these
 * inert named exports to keep MfaService importable without loading any ESM.
 */
module.exports = {
  generateSecret: () => 'STUB_SECRET',
  generateURI: () => 'otpauth://totp/stub',
  verify: async () => false,
};
