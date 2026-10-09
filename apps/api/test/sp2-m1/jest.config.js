const path = require('path');

/**
 * Opt-in SQL tests for the SP2 M1 catalogue (seeds, immutability trigger, CHECKs)
 * against a real Postgres with every migration applied. The default apps/api Jest
 * config (rootDir: src) never discovers these.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:5432/grw_sp2m1_test \
 *     npx jest --config test/sp2-m1/jest.config.js -i
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/sp2-m1'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }] },
  testEnvironment: 'node',
};
