import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**'],
    // The full suite intentionally runs CPU-heavy RSA/OIDC checks beside a 10,000-call HTTP
    // load test. Keep per-test deadlines bounded without inheriting Vitest's too-small 5s default.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      // Declarative catalogs are contract-tested exhaustively; V8 reports their
      // schema construction callbacks as uncovered executable branches.
      exclude: [
        'src/cli.ts',
        'src/operations/documents.ts',
        'src/operations/schemas.ts',
        'src/toolsets/catalog.ts',
        'src/prompts/catalog.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
    clearMocks: true,
    restoreMocks: true,
  },
});
