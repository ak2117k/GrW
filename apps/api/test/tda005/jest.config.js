const path = require('path');
const fs = require('fs');

/**
 * Standalone Jest config for the TDA-005 credential-vault tests.
 *
 * Mirrors test/tda003/jest.config.js: the default apps/api Jest config roots at
 * src/, so it never discovers specs under test/. This roots discovery at
 * test/tda005 while keeping apps/api as rootDir so ts-jest reads
 * apps/api/tsconfig.json.
 *
 * Run from apps/api:
 *   npx jest --config test/tda005/jest.config.js --verbose
 * (prefix DATABASE_URL_TEST=… for DB-backed specs).
 */
const rootDir = path.resolve(__dirname, '../..');

const moduleNameMapper = {
  // Specs that import the REAL AuthModule transitively load MfaService -> otplib
  // (v13) -> ESM-only @scure/base, which this transform does not process.
  // Redirect otplib to an inert CJS stub (MFA is never exercised here).
  '^otplib$': '<rootDir>/test/tda005/otplib.stub.js',
};

// Local-dev fallback: if the repo-root @prisma/client cannot be regenerated in
// place (its query-engine DLL is held locked by a running dev server), generate
// a self-contained client from the TDA-005 schema into a worktree-local dir and
// map @prisma/client to it so the DB-backed specs see the new columns:
//   npx prisma generate --schema ../../prisma/schema.tda005gen.prisma
// The dir is a build artifact (never committed). On a clean environment where
// @prisma/client is regenerated normally this fallback is absent and the mapping
// is skipped, so @prisma/client resolves the standard way.
const localClient = path.join(rootDir, '.tda005-client');
if (fs.existsSync(localClient)) {
  moduleNameMapper['^@prisma/client$'] = '<rootDir>/.tda005-client';
}

module.exports = {
  rootDir,
  roots: ['<rootDir>/test/tda005'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  moduleNameMapper,
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      { isolatedModules: true, tsconfig: { allowJs: true } },
    ],
  },
  testEnvironment: 'node',
};
