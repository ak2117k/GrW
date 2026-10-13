const path = require('path');

/**
 * Opt-in SQL tests for the SP2 M5 tables (CHECKs, append-only triggers, dedupe, cascades) and the
 * bounded ledger reads, against a THROWAWAY local Postgres on 127.0.0.1 with every migration applied.
 * The default apps/api Jest config (rootDir: src) never finds these.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:55434/grw_sp2m5_test \
 *     npx jest --config test/sp2-m5/jest.config.js -i
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/sp2-m5'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }] },
  testEnvironment: 'node',
};
