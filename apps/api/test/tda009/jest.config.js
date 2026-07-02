const path = require('path');

/**
 * Standalone Jest config for the TDA-009 versioned-consent tests.
 *
 * Mirrors test/tda008/jest.config.js: the default apps/api Jest config roots at
 * src/, so it never discovers specs under test/. This roots discovery at
 * test/tda009 while keeping apps/api as rootDir so ts-jest reads
 * apps/api/tsconfig.json.
 *
 * Run from apps/api:
 *   npx jest --config test/tda009/jest.config.js -v
 * (prefix DATABASE_URL_TEST=… for the DB-backed specs.)
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/tda009'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  // The endpoint spec imports the REAL AuthModule to exercise the global guard
  // wiring. AuthModule -> MfaService -> otplib (v13) transitively loads the
  // ESM-only @scure/base, which this transform does not process. Redirect
  // otplib to an inert CJS stub (MFA is never exercised by these tests).
  moduleNameMapper: {
    '^otplib$': '<rootDir>/test/tda009/otplib.stub.js',
  },
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      { isolatedModules: true, tsconfig: { allowJs: true } },
    ],
  },
  testEnvironment: 'node',
};
