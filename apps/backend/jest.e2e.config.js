/**
 * End-to-end tests against the running Docker stack (`docker compose up`), through the same
 * /api proxy and presigned storage URLs a browser uses.
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '\\.e2e-spec\\.ts$',
  testTimeout: 60_000,
};
