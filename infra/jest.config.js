/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { diagnostics: { warnOnly: false } }],
  },
  // Synthesizing several stacks takes a few seconds each.
  testTimeout: 120000,
};
