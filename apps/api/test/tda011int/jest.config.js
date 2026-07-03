const path = require('path');

/**
 * Standalone Jest config for the TDA-011 Phase-2 auto-execution INTEGRATION
 * tests (the ordered pipeline that composes the three merged Phase-1
 * sub-modules + the TDA-005/009/010 seams).
 *
 * Mirrors test/tda011b/jest.config.js: the default apps/api Jest config roots at
 * src/, so it never discovers specs under test/. This roots discovery at
 * test/tda011int while keeping apps/api as rootDir so ts-jest reads
 * apps/api/tsconfig.json.
 *
 * The pipeline is exercised with FAKES for consent/decrypt/broker/claim (spec
 * §12) — no DB, no Redis, no Nest boot, no real broker/KMS. The per-user broker
 * session factory transitively imports smartapi-javascript + the shared TOTP
 * util (no otplib), so no module-name stub is needed.
 *
 * Run from apps/api:
 *   npx jest --config test/tda011int/jest.config.js --runInBand --verbose
 */
const rootDir = path.resolve(__dirname, '../..');

module.exports = {
  rootDir,
  roots: ['<rootDir>/test/tda011int'],
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
