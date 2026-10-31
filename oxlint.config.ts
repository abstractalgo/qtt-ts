import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['eslint', 'typescript', 'unicorn', 'import'],
  categories: {
    correctness: 'error',
  },
  options: {
    reportUnusedDisableDirectives: 'error',
  },
  env: {
    builtin: true,
    es2026: true,
  },
  ignorePatterns: ['.yarn'],
  rules: {
    curly: 'error',
    'no-unused-vars': 'error',
    'typescript/no-explicit-any': 'error',
    'typescript/consistent-type-imports': 'error',
    'import/no-cycle': 'error',
  },
});
