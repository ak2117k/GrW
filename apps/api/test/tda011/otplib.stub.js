/**
 * Test stub for `otplib` (see test/tda010/otplib.stub.js). Present so any spec in
 * this suite that transitively imports the auth/tenant chain does not pull the
 * ESM-only @scure/base that ts-jest cannot transform. MFA is never exercised
 * here. The idempotency spec does not need it today, but the config maps otplib
 * to this file to stay consistent with tda010 and future TDA-011 specs.
 */
module.exports = {
  generateSecret: () => 'STUB_SECRET',
  generateURI: () => 'otpauth://totp/stub',
  verify: async () => false,
};
