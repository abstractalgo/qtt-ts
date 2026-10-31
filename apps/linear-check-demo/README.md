# linear-check-demo

Demo of [`linear-check`](../../packages/linear-check), the linear
ownership checker built on the TypeScript 7.1 API.

The domain is card payments. An authorization (`HeldFunds`) holds funds on a
card and must be captured or voided exactly once. A gateway session must be
closed exactly once.

- `src/payments.ts`: the API. `HeldFunds` and the session are `Linear<…>`.
- `src/main.ts`: correct usage. The checker reports nothing here.
- `src/mistakes.ts`: intentional mistakes, each marked `// error: <code>`.
  `main.ts` doesn't import it, so it never runs.

```sh
yarn start          # runs main.ts: Linear is erased, so there's no runtime effect
yarn check:linear   # the CLI: reports every line marked `// error:` and exits with 1
yarn lint:linear    # the same analysis through oxlint, as the editor runs it
```

## Editor

`oxlint.config.ts` here is a nested oxlint config that enables
`linear-check/oxlint-plugin`, so the oxc editor extension shows the
checker's errors as you type, including in unsaved edits. A nested config
replaces the root one rather than merging with it, so it extends the root
config explicitly. The root `yarn lint` runs with `--disable-nested-config`,
so the intentional errors in `mistakes.ts` don't fail it.

Passing a linear value as an argument moves it, unless the parameter is typed
`Borrow<…>` (see `describeHold`). The session's operations are methods
(`session.authorize(…)`): calling a method that doesn't declare
`this: Linear<…>` only borrows the session. `main.ts` also shows a tuple of
authorizations, each of which has to be consumed.
