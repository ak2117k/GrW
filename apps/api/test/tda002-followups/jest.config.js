const path = require('path');

/**
 * Standalone Jest config for the TDA-002 auth follow-ups (roadmap §8).
 *
 * Mirrors test/tda008/jest.config.js: the default apps/api Jest config roots at
 * src/, so it never discovers specs under test/. This roots discovery at
 * test/tda002-followups while keeping apps/api as rootDir so ts-jest reads
 * apps/api/tsconfig.json.
 *
 * Importing the real AuthModule pulls in MfaService -> otplib (v13), which
 * transitively loads ESM-only packages this transform does not process; map
 * otplib to an inert CJS stub (MFA is not exercised by these specs).
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_debt \
 *   JWT_SECRET=<secret> ENCRYPTION_KEY=<32+ chars> \
 *     npx jest --config test/tda002-followups/jest.config.js -v
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/tda002-followups'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  moduleNameMapper: {
    '^otplib$': '<rootDir>/test/tda002-followups/otplib.stub.js',
  },
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      { isolatedModules: true, tsconfig: { allowJs: true } },
    ],
  },
  testEnvironment: 'node',
};
