const path = require('path');

/**
 * Standalone Jest config for the TDA-011 auto-execution tests (Phase 1: the
 * per-user risk sizing service).
 *
 * Mirrors test/tda010/jest.config.js: the default apps/api Jest config roots at
 * src/, so it never discovers specs under test/. This roots discovery at
 * test/tda011 while keeping apps/api as rootDir so ts-jest reads
 * apps/api/tsconfig.json.
 *
 * Run from apps/api:
 *   npx jest --config test/tda011/jest.config.js --runInBand --verbose
 *
 * The sizing service is pure (no DB, no broker, no auth chain), so no otplib
 * stub or DATABASE_URL is required.
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/tda011'],
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
