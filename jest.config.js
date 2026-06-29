/** @type {import('jest').Config} */
module.exports = {
  // Delegate entirely to each app's own Jest config.
  // This ensures apps/api uses ts-jest (not Babel) and its own rootDir/transform settings.
  projects: ['<rootDir>/apps/api'],

  // Belt-and-suspenders: never pick up compiled output or worktree artefacts
  // even if a project config omits these exclusions.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/.claude/',
  ],
};
