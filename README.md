# qtt-ts

Quantitative ownership types for TypeScript, after quantitative type theory
(QTT): values typed `Quantity<T, N>` must
be consumed exactly `N` times, and linear ones, `Linear<T>` (`Quantity<T, 1>`),
exactly once. The types are erased at compile time, so there's no runtime
effect; a separate checker enforces them.

```ts
import type { Borrow, Linear } from 'qtt-check';

type HeldFunds = Linear<{ id: string; amount: number }>;

const auth = session.authorize(10, 'EUR');
describe(auth); // describe(auth: Borrow<HeldFunds>) only borrows it
capture(auth);
capture(auth); // use-after-move
```

- [`packages/qtt-check`](./packages/qtt-check): the checker, built on the
  TypeScript 7.1 beta API. It runs as a CLI and as an oxlint plugin, which
  shows its diagnostics in the editor. [`SPEC.md`](./packages/qtt-check/SPEC.md)
  defines the semantics.
- [`apps/qtt-check-demo`](./apps/qtt-check-demo): a small card-payments
  demo with correct code and a file of intentional mistakes.

## Setup

Node 24+ (see `.nvmrc`) and Yarn 4, which is checked in under `.yarn/releases`
and used through `yarnPath`, so Corepack isn't needed.

```sh
yarn install
yarn test:unit   # fixtures, through the CLI and the oxlint plugin
yarn ts          # type-check every workspace
yarn lint        # oxlint, without the nested configs that enable qtt-check
yarn fmt:check
```

Code runs directly on Node with type stripping; there's no build step.

## Editor

Install the oxc extension. The nested `oxlint.config.ts` files in
`packages/qtt-check` and `apps/qtt-check-demo` enable the
`qtt-check` oxlint plugin there, so its errors appear as you type. After
changing the checker's code, run **Oxc: Restart Server**.
