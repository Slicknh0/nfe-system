import { defineConfig } from 'vitest/config';

// Pacotes do monorepo resolvem para o source em teste (condição `source`).
export default defineConfig({
  resolve: { conditions: ['source'] },
  test: { testTimeout: 30_000 },
});
