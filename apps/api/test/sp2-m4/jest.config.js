const path = require('path');

/**
 * Opt-in SQL tests for the SP2 M4 lifecycle table (CHECKs, the widened paper-default CHECKs,
 * the seed, cascades, and the CorePositionRepository) against a THROWAWAY local Postgres on
 * 127.0.0.1 with every migration applied. The default apps/api Jest config (rootDir: src)
 * never finds these.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:55434/grw_sp2m4_test \
 *     npx jest --config test/sp2-m4/jest.config.js -i
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/sp2-m4'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }] },
  testEnvironment: 'node',
};
