import { defineConfig } from 'oxlint';

import root from '../../oxlint.config.ts';

// A nested config replaces the root one for files under it rather than merging, so this
// extends it explicitly. The fixtures contain intentional mistakes. Nested configs only
// apply in the editor: the root `yarn lint` runs with --disable-nested-config, so they
// don't fail it.
export default defineConfig({
  extends: [root],
  jsPlugins: ['./src/oxlint-plugin.ts'],
  overrides: [
    {
      files: ['fixtures/**/*.ts'],
      rules: {
        'qtt-check/use-after-move': 'error',
        'qtt-check/not-consumed': 'error',
        'qtt-check/captured': 'error',
        'qtt-check/overwritten': 'error',
        'qtt-check/discarded': 'error',
        'qtt-check/move-out-of-index': 'error',
        'qtt-check/moved-borrow': 'error',
      },
    },
  ],
});
