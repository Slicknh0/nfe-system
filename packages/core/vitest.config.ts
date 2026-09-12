import { defineConfig } from 'vitest/config';

// Pacotes do monorepo resolvem para o source em teste (condição `source`) e
// para `dist` em runtime. Sem isso o Vitest carregaria o build, possivelmente
// desatualizado.
export default defineConfig({
  resolve: { conditions: ['source'] },
});
