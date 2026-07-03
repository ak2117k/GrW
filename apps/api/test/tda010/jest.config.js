const path = require('path');

/**
 * Standalone Jest config for the TDA-010 signal fan-out engine tests.
 *
 * Mirrors test/tda003/jest.config.js: the default apps/api Jest config roots at
 * src/, so it never discovers specs under test/. This roots discovery at
 * test/tda010 while keeping apps/api as rootDir so ts-jest reads
 * apps/api/tsconfig.json.
 *
 * Run from apps/api:
 *   npx jest --config test/tda010/jest.config.js --runInBand --verbose
 * (prefix DATABASE_URL_TEST=… for the DB-backed eligibility spec).
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/tda010'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  // Specs that import the REAL AuthModule/TenantModule chain transitively load
  // MfaService -> otplib (v13) -> ESM-only @scure/base, which this transform
  // does not process. Redirect otplib to an inert CJS stub (MFA never runs here).
  moduleNameMapper: {
    '^otplib$': '<rootDir>/test/tda010/otplib.stub.js',
  },
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      { isolatedModules: true, tsconfig: { allowJs: true } },
    ],
  },
  testEnvironment: 'node',
  // The dlq-integration spec drives REAL Bull queues on Redis; Bull keeps its
  // ioredis clients open past teardown (a known Bull/Jest interaction), so force
  // Jest to exit after the suite completes rather than hang on those handles.
  forceExit: true,
};
