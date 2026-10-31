import { defineConfig } from 'oxlint';

import root from '../../oxlint.config.ts';

const linearRules = [
  'linear-check/use-after-move',
  'linear-check/not-consumed',
  'linear-check/captured',
  'linear-check/overwritten',
  'linear-check/discarded',
  'linear-check/move-out-of-index',
  'linear-check/moved-borrow',
] as const;

// A nested config replaces the root one for files under it rather than merging, so this
// extends it explicitly. Nested configs only apply in the editor: the root `yarn lint`
// runs with --disable-nested-config, so the intentional errors in mistakes.ts don't fail it.
export default defineConfig({
  extends: [root],
  jsPlugins: ['linear-check/oxlint-plugin'],
  rules: Object.fromEntries(linearRules.map((rule) => [rule, 'error'])),
});
