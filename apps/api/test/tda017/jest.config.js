const path = require('path');

/**
 * Standalone Jest config for TDA-017 (payments). Mirrors test/tda015: roots at
 * test/tda017, rootDir at apps/api so ts-jest reads apps/api/tsconfig.json.
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda017 \
 *     npx jest --config test/tda017/jest.config.js --runInBand --verbose
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/tda017'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  moduleNameMapper: {
    '^otplib$': '<rootDir>/test/tda017/otplib.stub.js',
  },
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true, tsconfig: { allowJs: true } }],
  },
  testEnvironment: 'node',
};
