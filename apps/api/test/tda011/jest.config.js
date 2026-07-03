const path = require('path');

/**
 * Standalone Jest config for the TDA-011 auto-execution tests (Phase 1:
 * ExecutionClaim idempotency store).
 *
 * Mirrors test/tda010/jest.config.js: the default apps/api Jest config roots at
 * src/, so it never discovers specs under test/. This roots discovery at
 * test/tda011 while keeping apps/api as rootDir so ts-jest reads
 * apps/api/tsconfig.json.
 *
 * The DB-backed idempotency spec runs concurrent claims against ONE scratch DB;
 * run with --runInBand so parallel Jest workers never share/flake that DB.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda011a \
 *     npx jest --config test/tda011/jest.config.js --runInBand --verbose
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/tda011'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  // Specs that import the REAL Tenant/Auth chain transitively load otplib (v13)
  // -> ESM-only @scure/base, which this transform does not process. Redirect
  // otplib to an inert CJS stub (MFA never runs here).
  moduleNameMapper: {
    '^otplib$': '<rootDir>/test/tda011/otplib.stub.js',
  },
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      { isolatedModules: true, tsconfig: { allowJs: true } },
    ],
  },
  testEnvironment: 'node',
};
