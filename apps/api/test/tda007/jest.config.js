const path = require('path');

/**
 * Standalone Jest config for the TDA-007 subscription tests.
 *
 * Mirrors test/tda003/jest.config.js: the default apps/api Jest config roots at
 * src/, so it never discovers specs under test/. This roots discovery at
 * test/tda007 while keeping apps/api as rootDir so ts-jest reads
 * apps/api/tsconfig.json.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test \
 *     npx jest --config test/tda007/jest.config.js subscription --verbose
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/tda007'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  // The SubscriptionModule chain can transitively pull otplib (ESM-only
  // @scure/base) which this transform does not process. Redirect otplib to an
  // inert CJS stub (MFA is never exercised by these tests).
  moduleNameMapper: {
    '^otplib$': '<rootDir>/test/tda007/otplib.stub.js',
  },
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      { isolatedModules: true, tsconfig: { allowJs: true } },
    ],
  },
  testEnvironment: 'node',
};
