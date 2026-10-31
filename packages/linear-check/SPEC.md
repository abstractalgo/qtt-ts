# Linear ownership spec

The semantics `linear-check` implements, through both its CLI and its
oxlint plugin. `fixtures/` is the executable form of this spec.

## Marking values

```ts
declare const linearBrand: unique symbol;
export type Linear<T> = T & { readonly [linearBrand]?: true };
```

It's type-only and erased at compile time, so it has no runtime effect. Each
package exports it from `src/index.ts`. `linear-check` also exports `Borrow<T>`
from there; see [Borrowed parameters](#borrowed-parameters).

A **linear binding** is a local variable, `let`/`const`/`using` declaration or
function parameter whose value is linear:

The binding's type is linear if it, or any member of a union it belongs to,
carries the `linearBrand` property declared in the package's `src/index.ts`, or
is a linear container (see [Containers](#containers)). This includes types that
are only inferred.

## Uses

Each reference to a linear binding is one of:

- **Borrow:** the value is read without being consumed. This covers property
  access (`t.id`, `t['id']`), destructuring (`const { id } = t`), `typeof t`,
  a method call `t.m()` whose method has no `this` parameter typed linear, and
  passing `t` to a parameter typed `Borrow<…>`. When the property or
  destructured part is itself linear, see [Containers](#containers).
- **Move:** the value is consumed. This covers any other use as a value: a call
  argument (whatever the parameter's type, unless it's `Borrow<…>`), `return t`, `const u = t`,
  `x = t`, `throw t`, `yield t`, `await t`, `void t` (an explicit drop), an
  object, array or spread element, and a method call `t.m()` where `m` declares
  `this: Linear<…>`.

## Diagnostics

The CLI prints these codes. In the oxlint plugin, each code is a rule name,
e.g. `linear-check/use-after-move`.

| Code                | Reported at                                        | When                                                                                                                                                                       |
| ------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `use-after-move`    | the offending use                                  | Any use, borrow or move, of a binding that is moved on at least one path reaching it                                                                                       |
| `not-consumed`      | the binding's declaration (the line with its name) | The binding can go out of scope, by falling off the end of the block or by `return`, `break` or `continue` leaving it, without being moved on every path                   |
| `captured`          | the reference inside the nested function           | A nested function, arrow or class method refers to a linear binding from an outer function. This counts as a move at that point, so it doesn't also cause a `not-consumed` |
| `overwritten`       | the assignment                                     | A `let` linear binding is assigned while it may still hold an unconsumed value                                                                                             |
| `discarded`         | the expression statement                           | An expression statement produces a linear value that is not stored (`mint();`)                                                                                             |
| `move-out-of-index` | the element access                                 | A linear element is moved out by a computed index (`pair[i]`) or out of an array rather than a tuple (`tokens[0]`).                                                        |
| `moved-borrow`      | the offending use                                  | A `Borrow<…>` parameter is moved: passed to a non-`Borrow` parameter, returned, stored, or used with a consuming method.                                                   |

## Control flow

Track a state for each linear binding: `owned`, `moved` or `maybe-moved`.

- **Branches** (`if`/`else`, ternaries, `&&`/`||`/`??`, `switch` with
  fallthrough, `try`/`catch`/`finally`): when paths join, a binding that
  differs between them becomes `maybe-moved`. Using a binding that is `moved`
  or `maybe-moved` is a `use-after-move`.
- **Loops:** iterate to a fixed point. A move in the body flows back to the
  loop head through the back edge. A loop condition that is the literal
  `true`, or a `for (;;)` with no condition, has no exit edge; it is left only
  by `break`, `return` or `throw`.
- **`try`/`catch`:** a `catch` block's starting state is the join of every
  state the `try` block passes through, since it could throw anywhere.
  `finally` runs on every path.
- **Exits by `throw`:** these are exempt from `not-consumed`. Leaving the
  scope by throwing doesn't require the binding to have been consumed.
- **After an error:** a move that is itself a `use-after-move` still leaves
  the binding `moved`, so one mistake doesn't cascade into more diagnostics.
- **Scopes:** each function body is analysed on its own. Module top-level code
  is analysed as a scope too.

## Borrowed parameters

```ts
declare const borrowBrand: unique symbol;
export type Borrow<T> = T & { readonly [borrowBrand]?: true };
```

A parameter typed `Borrow<…>` lets a function read a linear value without
taking ownership of it, like `&T` in Rust:

```ts
function describe(auth: Borrow<HeldFunds>): string {
  return `${auth.amount} ${auth.currency}`;
}

const auth = session.authorize(10, 'EUR');
describe(auth); // a borrow: the caller still owns auth
capture(auth);
```

- **At the call site:** passing a linear binding (or a linear part of one) to a
  `Borrow<…>` parameter borrows it. Borrowing a moved value is still a
  `use-after-move`.
- **Inside the function:** the parameter is not linear, so it doesn't need to be
  consumed and is never `not-consumed`. It may be read, passed to another
  `Borrow<…>` parameter, and captured by closures. Moving it in any other way
  is a `moved-borrow`.
- A type carrying the borrow brand is never linear, even if it also carries the
  linear brand.

## Containers

Linear values put into tuples, objects or arrays stay tracked, as in Rust and
Linear Haskell.

- **Linear containers:** a type is linear if it carries the brand, or if any
  tuple element, non-function property or array element type is linear. So
  `readonly [HeldFunds, HeldFunds]`, `{ first: Token; label: string }` and
  `readonly Token[]` are linear, while `Promise<Token>` (whose properties are
  methods) is not.
- **Places:** state is tracked per place, not just per binding. A place is a
  binding followed by fixed property names or literal tuple indices: `pair`,
  `pair[0]`, `held.first`, `held.first.inner`.
- **Moving a part:** `pair[0]` or `held.first` used as a move moves that place
  only (a partial move). Its siblings stay owned. Using a moved place, or a
  place containing it (including the whole container), is a `use-after-move`.
  Reading through a part (`pair[0].id`) is a borrow.
- **Consumed means every part:** a container binding is consumed once it has
  been moved as a whole or each of its linear parts has been moved.
  Otherwise it's `not-consumed`, reported at the binding's declaration.
- **Destructuring:** `const [a, b] = pair` or `const { first } = held` moves
  the linear parts it names into new linear bindings. The parts it doesn't
  name stay owned by the container, and non-linear parts are only read.
- **Computed indices and arrays:** a linear element can only be moved out by a
  fixed position of a tuple or object. Moving one out by a computed index
  (`pair[i]`) or out of an array (`tokens[0]`) is a `move-out-of-index`, which
  then counts as moving the whole container, so it doesn't cascade.
- **Iteration:** `for (const t of tokens)` over a linear container moves the
  container. Its loop variable is a linear binding for each iteration.

## Fixture format

```ts
spend(t); // error: use-after-move
```

A trailing `// error: <code>` comment marks a line where that diagnostic is
expected. A line may list several codes, separated by commas. Every other line
must produce no diagnostics. Tests compare the set of `(file, line, code)`
pairs exactly.
