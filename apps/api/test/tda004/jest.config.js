const path = require('path');

/**
 * Standalone Jest config for the TDA-004 security-hardening tests.
 *
 * Mirrors test/tda003/jest.config.js: the default apps/api Jest config roots at
 * src/, so it never discovers specs under test/. This roots discovery at
 * test/tda004 while keeping apps/api as rootDir so ts-jest reads
 * apps/api/tsconfig.json.
 *
 * Run from apps/api:
 *   npx jest --config test/tda004/jest.config.js --verbose
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/tda004'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  // Specs that import the REAL AuthModule transitively load MfaService -> otplib
  // (v13) -> ESM-only @scure/base, which this transform does not process.
  // Redirect otplib to an inert CJS stub (MFA is never exercised here).
  moduleNameMapper: {
    '^otplib$': '<rootDir>/test/tda004/otplib.stub.js',
  },
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      { isolatedModules: true, tsconfig: { allowJs: true } },
    ],
  },
  testEnvironment: 'node',
};
