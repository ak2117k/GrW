const path = require('path');

/**
 * Opt-in SQL tests for the SP2 M2 risk tables (seed defaults, append-only trigger,
 * CHECKs, user cascade) against a THROWAWAY local Postgres on 127.0.0.1 with every
 * migration applied. The default apps/api Jest config (rootDir: src) never finds these.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:55432/grw_sp2m2_test \
 *     npx jest --config test/sp2-m2/jest.config.js -i
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/sp2-m2'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }] },
  testEnvironment: 'node',
};
