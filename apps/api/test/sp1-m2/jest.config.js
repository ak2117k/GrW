const path = require('path');

/**
 * Opt-in SQL tests for the SP1 M2 CandleStore against a real TimescaleDB.
 * The default apps/api Jest config (rootDir: src) never discovers these.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:5432/grw_m2_test \
 *     npx jest --config test/sp1-m2/jest.config.js -i
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/sp1-m2'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }] },
  testEnvironment: 'node',
};
