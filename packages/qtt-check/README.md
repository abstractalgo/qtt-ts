# qtt-check

A quantitative ownership checker for TypeScript: values typed `Quantity<T, N>` must be consumed exactly `N` times,
and `Linear<T>`, which is `Quantity<T, 1>`, exactly once. It is a standalone CLI built on the TypeScript 7.1 beta
compiler API (`typescript/sync`).
[`SPEC.md`](./SPEC.md) defines the semantics and [`fixtures/`](./fixtures) is the executable spec.

```ts
import type { Linear } from 'qtt-check';

type Token = Linear<{ readonly id: string }>;

const t = mint();
spend(t);
spend(t); // use-after-move
```

With a grade above 1, each call that passes the value consumes as many uses as the parameter's grade: one for a plain
or `Linear` parameter, `k` for a `Quantity<…, k>` one. Returning, storing or assigning the value moves it whole, which
needs every use still left, and `void t` drops whatever is left.

```ts
import type { Quantity } from 'qtt-check';

type Ticket = Quantity<{ readonly id: string }, 3>;

declare function punch(t: { readonly id: string }): void; // one use
declare function punchTwice(t: Quantity<{ readonly id: string }, 2>): void; // two uses

const ticket = issue();
punch(ticket);
punchTwice(ticket); // three uses in all: done
punch(ticket); // use-after-move: a fourth use
```

`Borrow<T>` marks a parameter that reads a linear value without taking ownership (like `&T` in Rust), and linear
values inside tuples, objects and arrays stay tracked:

```ts
import type { Borrow } from 'qtt-check';

declare function describe(t: Borrow<Token>): string;

const pair = [mint(), mint()] as const;
describe(pair[0]); // a borrow: pair still owns both tokens
spend(pair[0]);
spend(pair[1]); // pair is now consumed, part by part
```

## Usage

```sh
qtt-check [-p path/to/tsconfig.json] [files...]
```

- With `-p`, the program comes from that tsconfig. Without it, `./tsconfig.json` is used if it exists.
- With files, only those files are reported on (the tsconfig still supplies the options and the rest of the program).
  With files and no tsconfig, the files are checked with strict default options.
- Output is one `path:line:col  code  message` line per diagnostic, then a summary line.
  The exit code is 1 when there are diagnostics and 2 on usage or internal errors.

From the package: `node src/cli.ts -p ../../apps/qtt-check-demo/tsconfig.json`. The code runs directly on
Node 24+ with type stripping; there is no build step.

## In the editor, through oxlint

TypeScript 7's language server can't load plugins: `compilerOptions.plugins` is parsed but ignored. To get these
diagnostics in the editor anyway, `qtt-check/oxlint-plugin` runs the same analysis as an oxlint JS
plugin, so the oxc extension's language server shows them. Its rules are `qtt-check/use-after-move`,
`qtt-check/not-consumed`, `qtt-check/captured`, `qtt-check/overwritten`, `qtt-check/discarded`,
`qtt-check/move-out-of-index` and `qtt-check/moved-borrow`.

```ts
// oxlint.config.ts (nested, next to the code to check)
export default defineConfig({
  extends: [rootConfig], // see apps/qtt-check-demo/oxlint.config.ts
  jsPlugins: ['qtt-check/oxlint-plugin'],
  rules: { 'qtt-check/use-after-move': 'error' /* … */ },
});
```

How it works:

- Each oxlint process starts one TypeScript API process and keeps it alive.
- For every linted file, it rebuilds the program from the nearest `tsconfig.json`. The linted file's text comes
  from oxlint, so unsaved edits are checked; every other file is read from disk.
- If the beta API process crashes, the plugin reports nothing for that file and starts a fresh process for the next.

Verified with `oxlint --lsp`: an unsaved second capture in `apps/qtt-check-demo/src/main.ts` was reported as an
error 126 ms after the file was opened. Unsaved edits to _other_ files aren't seen until they're saved, and
`tsconfig.json` changes need an oxc server restart (parsed configs are cached).

After changing this package's code, restart the oxc server too (**Oxc: Restart Server**). The language server keeps
the JS plugin it loaded for its whole lifetime. If a config enables a rule that the loaded copy doesn't have yet,
oxlint skips the entire config, so no `qtt-check` diagnostics appear at all. The **Output → Oxc (Lint)** panel
then shows `Rule '…' not found in plugin 'qtt-check'`.

Programmatic use: `checkProject({ cwd, project, files })` from `src/check.ts`, or `checkProgram(api, program, fileNames)`
if you already hold a `Program`.

## Design

**Linearity detection** is type-based. The checker finds this package's `src/index.ts` in the program (by real path,
or as `node_modules/qtt-check/src/index.ts`), locates the `[quantityBrand]` and `[borrowBrand]` property
signatures in it, and takes those symbols' escaped names (`__@quantityBrand@<id>`). The id makes each name unique to its
declaration within the program, so a type carries a brand when `getPropertiesOfType` returns a property with that
name. If the brand file isn't in the program, nothing can be linear and the analysis returns immediately.

A type is linear if it carries the linear brand, or if any union member, base constraint, non-method property type
or number index type is linear. So tuples, objects with linear fields and arrays of linear values are linear
containers, while `Promise<Token>` (whose properties are methods) is not. A type carrying the borrow brand is never
linear. The checker explores the type graph breadth first, one batch of queries per level, and then propagates
linearity backwards from branded types, which handles recursive types. A branded type's grade is read from its brand
property: the property's type has one numeric key, the `N` of `Quantity<T, N>`, which costs two more batched queries
per level that finds brands. Three cuts keep the graph small:

- Interfaces and classes declared only in lib or `node_modules` files can't mention the brand, so they aren't
  expanded. Instantiations of generic ones (`Array<Token>`, `ZodObject<…>`) are expanded only when one of their type
  arguments turns out to be linear.
- Base constraints are followed only for the type being asked about and its union members. A conditional or indexed
  access type reached through a property stays opaque; following those through a form library's deep mapped types
  produced an unbounded stream of new types.
- Method properties are skipped without asking for their types.

**Querying the checker** happens up front, in batches. One pass over each file collects every binding name
(variables, parameters of functions with bodies, destructured elements), every expression statement, and the
right-hand sides of assignments to names that turn out to be linear. Their types come back through
`api.batch(checker.getTypeAtLocation.gen(nodes))` in chunks of 4,000, and property lists are fetched the same way,
cached by type id. Calls whose receiver or arguments mention a linear or borrowed binding by name have their signatures
resolved in one batch: a linear `this` parameter makes a method call consume as many uses as its grade, a parameter
type carrying the borrow brand makes the argument a borrow, and any other parameter type's grade (1 if it isn't linear)
is what passing the argument consumes. Element accesses on those bindings are typed in a batch too, to recognise moves of
linear elements by index.

**The dataflow analysis** is an abstract interpreter over the AST rather than an explicit CFG. Each function body,
arrow, method, class field initializer and the module top level is a separate unit. The state maps each _place_ to
the range `lo..hi` of how many of its uses have been consumed on the paths reaching that point; each place has a
grade, its type's `N`, and the counts are capped at it. For a linear place this is owned (`0..0`), moved (`1..1`) or
maybe moved (`0..1`). A place is a linear binding, or a binding followed by property names or literal
indices that each lead to a linear part of its type (`pair[0]`, `held.first.inner`). The binding itself is in the state
while it's in scope; a place under it is added when it's consumed. A place inside a fully consumed one counts as fully
consumed, and one inside a partly or maybe consumed one as possibly used up. Joins merge these effective ranges, so a
container moved whole on one path and part by part on the other is moved on both. Statements return the outgoing
state, or `null` when control can't fall through. `return`, `throw`, `break` and `continue` are dispatched through a
stack of frames: loop and switch frames collect break and continue states; catch frames collect the join of every
state seen in the `try` block (recorded at entry and after every move or assignment); finally frames hold pending
exits, run the `finally` block once per kind of exit and then re-dispatch it. Leaving a scope by any route other than
`throw` reports bindings whose `lo` is below their grade. Loops iterate until the head state stops changing; a place
whose `hi` grows along the back edge is widened to its grade, since the loop could consume it on any number of
iterations, so a `Quantity<T, 500>` needs no more iterations than a `Linear<T>`. Diagnostics are keyed by position and
code, and the state only climbs the lattice, so repeated iterations can't produce stale reports.

Places determine what each use touches. Moving a place moves everything under it. A use that costs `k` (0 for a
borrow) conflicts with the place itself when `hi + k` exceeds its grade (for a borrow, when `hi` reaches it). A move,
consume or whole-value borrow (a call argument, a method call receiver) also conflicts with a consumed place above or
below it, while reading through a
part (`pair[0].id`, `held.label`) conflicts only with the place and those above it, so a sibling's move doesn't
matter. A container binding is consumed when it was moved whole or each of its linear parts is consumed, recursively,
and it's reported as `not-consumed` at its declaration otherwise. Destructuring moves the named linear parts into the
new bindings. A move by a computed index, or by any index into an array, has no fixed place, so it's reported as
`move-out-of-index` and moves the whole container. `for … of` moves what it iterates.

`Borrow<…>` parameters are bindings that aren't in the state at all. Any move of one, or of a part of one, is reported
as `moved-borrow`; reads, borrows and captures are fine. Since they have no state, they're also resolved from inside
nested functions, so moving a captured borrow is reported too.

Name resolution is lexical and done by this package, not by the TypeScript checker, which keeps IPC traffic proportional to
declarations rather than references. When a nested function or class is created, its body is scanned for references
to the enclosing unit's linear bindings that aren't shadowed inside; each one is reported as `captured`, and the binding
counts as moved at the point of creation.

## Known limitations

- Hoisting is ignored: a function declaration captures (and moves) at its position in the source, not at the top of
  its scope, and `var` is treated as block-scoped.
- Optional chains don't short-circuit: in `t?.m(x)`, `x` counts as moved even when `t` is nullish.
- Implicit exceptions are only modelled inside `try`. A call that throws outside a `try` is fine anyway because
  throw exits are exempt from `not-consumed`.
- Code after an unconditional `return`, `throw`, `break` or `continue` isn't analysed, including nested functions in
  it.
- Every use the spec doesn't list as a borrow is a move, including `t === x`, `!t` and `` `${t}` ``. This follows
  `SPEC.md` but is strict in practice.
- For destructuring assignments, `for (x of …)` with an existing binding, and `case` labels, assigned values are
  assumed linear rather than type-checked.
- Linear parts are found from the binding's declared type. A part only visible after narrowing (a member of a union
  with more than one linear member) isn't a place, so moving it reads the container instead.
- Generic conditional and indexed access types inside a container's properties aren't resolved, and
  `Map<string, Token>`-like types aren't containers (their contents are behind methods), as `SPEC.md` says.
- Assigning to a part (`held.first = mint()`) re-initialises it if it was moved, and is `overwritten` otherwise.

## Timings

Measured on an Apple Silicon laptop, wall clock, Node 24.

| Run                                                                 | Files analysed | Time                                                |
| ------------------------------------------------------------------- | -------------- | --------------------------------------------------- |
| `tsconfig.json` (`fixtures/`, `src/`, `test/`)                      | 20             | 0.16s to 0.21s (vitest suite, CLI and oxlint: 1.2s) |
| `apps/dashboard/tsconfig.json` (no `Linear` import, short-circuits) | 2,626          | 0.5s to 0.7s                                        |
| `apps/dashboard` with the brand file forced into the program        | 2,627          | 9.1s to 9.4s                                        |

The forced run uses a tsconfig that extends the dashboard's and adds `src/index.ts` to `files`. 35,000 binding names
and 13,000 expression statements are typed; about 3.3s goes to the first `getTypeAtLocation` batch, which is the Go
checker inferring types across the program. Container propagation adds about 2.6s: with it switched off, the same
run takes 6.6s. Before the cuts above, the type graph had 175,000 types and the run took 18s; the constraint cut
brought that to 53,000 types and 11.6s, and the external-type cut to 9.2s. The dataflow pass takes about 0.5s.
