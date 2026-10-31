import { defineConfig } from 'oxlint';

import root from '../../oxlint.config.ts';

const qttRules = [
  'qtt-check/use-after-move',
  'qtt-check/not-consumed',
  'qtt-check/captured',
  'qtt-check/overwritten',
  'qtt-check/discarded',
  'qtt-check/move-out-of-index',
  'qtt-check/moved-borrow',
] as const;

// A nested config replaces the root one for files under it rather than merging, so this
// extends it explicitly. Nested configs only apply in the editor: the root `yarn lint`
// runs with --disable-nested-config, so the intentional errors in mistakes.ts don't fail it.
export default defineConfig({
  extends: [root],
  jsPlugins: ['qtt-check/oxlint-plugin'],
  rules: Object.fromEntries(qttRules.map((rule) => [rule, 'error'])),
});
