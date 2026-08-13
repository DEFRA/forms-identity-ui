const { CI } = process.env

/**
 * Jest config
 * @type {Config.InitialOptions}
 */
export default {
  resetMocks: true,
  resetModules: true,
  restoreMocks: true,
  clearMocks: true,
  silent: false,
  testMatch: ['<rootDir>/src/**/*.test.{cjs,js,mjs}'],
  reporters: CI
    ? [['github-actions', { silent: false }], 'summary']
    : ['default', 'summary'],
  collectCoverageFrom: ['<rootDir>/src/**/*.{cjs,js,mjs}'],
  coveragePathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/.server',
    '<rootDir>/.public',
    '<rootDir>/src/client/(?!javascripts)'
  ],
  coverageDirectory: '<rootDir>/coverage',
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  setupFilesAfterEnv: ['<rootDir>/jest.environment.js', 'jest-extended/all'],
  transform: {
    '^.+\\.(cjs|js|mjs)$': [
      'babel-jest',
      {
        browserslistEnv: 'node',
        plugins: ['transform-import-meta'],
        rootMode: 'upward'
      }
    ]
  },

  // Enable Babel transforms for node_modules
  // See: https://jestjs.io/docs/ecmascript-modules
  transformIgnorePatterns: [
    `node_modules/(?!${[
      '@defra/hapi-tracing', // Supports ESM only
      'nanoid', // Supports ESM only
      'oidc-provider', // Supports ESM only
      'quick-lru', // Supports ESM only
      'raw-body', // Supports ESM only
      'eta', // Supports ESM only
      'jose' // Supports ESM only
    ].join('|')}/)`
  ],
  testEnvironment: 'node',
  testTimeout: 10000,
  forceExit: true
}

/**
 * @import { Config } from '@jest/types'
 */
