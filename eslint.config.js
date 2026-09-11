// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Regras escolhidas para o que este domínio realmente arrisca.
 *
 * Formatação não entra: `tsc` com `strict` e `noUnusedLocals` já cobre boa
 * parte, e regra de estilo sem formatter só gera ruído. O que está aqui são
 * regras que pegam erro de correção — sobretudo em código que decide valor
 * fiscal e trata Promise de rede.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'schemas/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `any` desliga o verificador exatamente onde ele mais importa.
      '@typescript-eslint/no-explicit-any': 'error',

      // Promise ignorada em chamada à SEFAZ vira falha silenciosa.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Conversão implícita de objeto para string em template mascara perda de
      // precisão monetária — `Decimal` precisa passar por `toFixed`, não por
      // interpolação acidental.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      // Erro precisa ser Error tipado — a hierarquia fiscal/técnica depende disso.
      '@typescript-eslint/only-throw-error': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Arquivos de configuração em JS não pertencem a nenhum tsconfig e não
    // precisam de análise baseada em tipos.
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
  {
    // Testes podem afirmar sobre valores desconhecidos sem cerimônia.
    files: ['**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
);
