import { defineConfig } from 'vitest/config';

// Pacotes do monorepo resolvem para o source em teste (condição `source`).
// O Postgres real sobe uma vez por execução, no global setup; cada arquivo de
// teste cria o próprio banco.
export default defineConfig({
  resolve: { conditions: ['source'] },
  test: {
    globalSetup: ['./tests/support/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
