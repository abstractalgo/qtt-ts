import { defineConfig } from 'oxfmt';

export default defineConfig({
  bracketSpacing: true,
  singleQuote: true,
  printWidth: 80,
  ignorePatterns: ['.yarn'],
  sortImports: {
    newlinesBetween: true,
    groups: [
      ['builtin', 'external'],
      [
        'type-internal',
        'value-internal',
        'type-sibling',
        'value-sibling',
        'value-parent',
        'type-parent',
        'type-index',
        'value-index',
        'unknown',
      ],
    ],
  },
});
