/**
 * Inert `otplib` stub (see test/tda008/otplib.stub.js for rationale).
 *
 * The real otplib v13 pulls in ESM-only deps this suite's ts-jest transform does
 * not process. These specs import the REAL AuthModule to exercise the auth-core
 * HTTP seam and never invoke MFA, so map otplib to inert named exports to keep
 * MfaService importable without loading any ESM.
 */
module.exports = {
  generateSecret: () => 'STUB_SECRET',
  generateURI: () => 'otpauth://totp/stub',
  verify: async () => false,
};
