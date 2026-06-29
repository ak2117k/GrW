const path = require('path');

/**
 * Standalone Jest config for the TDA-003b system-write (engine no-context)
 * tests. Mirrors test/tda003/jest.config.js: roots discovery at test/tda003b
 * while keeping apps/api as rootDir so ts-jest reads apps/api/tsconfig.json.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test \
 *     npx jest --config test/tda003b/jest.config.js -v
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/tda003b'],
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
