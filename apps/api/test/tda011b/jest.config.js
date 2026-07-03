const path = require('path');

/**
 * Standalone Jest config for the TDA-011 PerUserBrokerSessionFactory tests.
 *
 * Mirrors test/tda005/jest.config.js: the default apps/api Jest config roots at
 * src/, so it never discovers specs under test/. This roots discovery at
 * test/tda011b while keeping apps/api as rootDir so ts-jest reads
 * apps/api/tsconfig.json.
 *
 * The factory under test is a pure unit (the SmartAPI client is injected + faked),
 * so this suite needs no DB, no Nest boot, and no otplib stub.
 *
 * Run from apps/api:
 *   npx jest --config test/tda011b/jest.config.js --runInBand --verbose
 */
const rootDir = path.resolve(__dirname, '../..');

module.exports = {
  rootDir,
  roots: ['<rootDir>/test/tda011b'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      { isolatedModules: true, tsconfig: { allowJs: true } },
    ],
  },
  testEnvironment: 'node',
};
