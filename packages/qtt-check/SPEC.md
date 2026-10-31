# Quantitative ownership spec

The semantics `qtt-check` implements, through both its CLI and its
oxlint plugin. `fixtures/` is the executable form of this spec.

## Marking values

```ts
declare const quantityBrand: unique symbol;
interface Uses {
  readonly uses?: true;
}
export type Quantity<T, N extends number> = T & {
  readonly [quantityBrand]?: Uses & { readonly [K in `${N}`]?: true };
};
export type Linear<T> = Quantity<T, 1>;
```

A value of type `Quantity<T, N>` must be consumed exactly `N` times; `N` is its
**grade**. `Linear<T>` is the special case `N = 1`, and everything below
reduces to plain linear ownership for it. The types are erased at compile time,
so they have no runtime effect. `qtt-check` exports them, and `Borrow<T>`
(see [Borrowed parameters](#borrowed-parameters)), from `src/index.ts`.

The brand's payload has a key per grade plus a key every grade shares, so
`Quantity<T, 3>` and `Quantity<T, 1>` are assignable to each other: TypeScript
doesn't reject passing a three-use value where one use is expected, or the
reverse. The checker decides whether the use fits. `N` must be a non-negative
integer literal; if a type carries several grades
(`Quantity<Quantity<T, 2>, 3>`), the largest applies.

A **linear binding** is a local variable, `let`/`const`/`using` declaration or
function parameter whose value is linear:

The binding's type is linear if it, or any member of a union it belongs to,
carries the `quantityBrand` property declared in the package's `src/index.ts`,
or is a linear container (see [Containers](#containers)). This includes types
that are only inferred. Its grade is its type's grade; for a union, the largest
grade among its linear members; for an unbranded container, 1.

## Uses

Each reference to a linear binding is one of:

- **Borrow:** the value is read without being consumed. This covers property
  access (`t.id`, `t['id']`), destructuring (`const { id } = t`), `typeof t`,
  a method call `t.m()` whose method has no `this` parameter typed linear, and
  passing `t` to a parameter typed `Borrow<…>`. When the property or
  destructured part is itself linear, see [Containers](#containers).
- **Consume `k`:** the value is used `k` times. This covers a call argument,
  where `k` is the grade of the parameter's type (so 1 for a plain or `Linear`
  parameter, `k` for a `Quantity<…, k>` one, and the argument's own grade for a
  generic parameter inferred from it), and a method call `t.m()` where `m`
  declares `this: Quantity<…, k>` (`k = 1` for `this: Linear<…>`).
- **Move:** the value is consumed whole, taking all its uses. This covers any
  other use as a value: `return t`, `const u = t`, `x = t`, `throw t`,
  `yield t`, `await t`, an object, array or spread element, and a call whose
  signature can't be resolved. A move needs every use still to be left.
- **Drop:** `void t` explicitly gives up whatever uses are left.

For a linear binding, consuming once, moving and dropping all mean the same
thing: the binding is moved.

## Diagnostics

The CLI prints these codes. In the oxlint plugin, each code is a rule name,
e.g. `qtt-check/use-after-move`.

| Code                | Reported at                                        | When                                                                                                                                                                       |
| ------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `use-after-move`    | the offending use                                  | A use needs more uses than may be left on some path reaching it: a borrow after all `N` are consumed, a consume past `N`, or a move after any                              |
| `not-consumed`      | the binding's declaration (the line with its name) | The binding can go out of scope, by falling off the end of the block or by `return`, `break` or `continue` leaving it, without being consumed `N` times on every path      |
| `captured`          | the reference inside the nested function           | A nested function, arrow or class method refers to a linear binding from an outer function. This counts as a move at that point, so it doesn't also cause a `not-consumed` |
| `overwritten`       | the assignment                                     | A `let` linear binding is assigned while it may still hold an unconsumed value                                                                                             |
| `discarded`         | the expression statement                           | An expression statement produces a linear value that is not stored (`mint();`)                                                                                             |
| `move-out-of-index` | the element access                                 | A linear element is moved out by a computed index (`pair[i]`) or out of an array rather than a tuple (`tokens[0]`).                                                        |
| `moved-borrow`      | the offending use                                  | A `Borrow<…>` parameter is moved: passed to a non-`Borrow` parameter, returned, stored, or used with a consuming method.                                                   |

## Control flow

Track, for each linear binding, how many of its uses have been consumed, as a
range `lo..hi` over the paths reaching each point. For a linear binding, `0..0`
is owned, `1..1` moved and `0..1` maybe moved.

- **Branches** (`if`/`else`, ternaries, `&&`/`||`/`??`, `switch` with
  fallthrough, `try`/`catch`/`finally`): when paths join, the ranges are
  merged. A use that costs `k` (0 for a borrow) is a `use-after-move` when
  `hi + k` exceeds `N`, or for a borrow when `hi` reaches `N`. Leaving scope
  needs `lo = N`.
- **Loops:** iterate to a fixed point. A consumption in the body flows back to
  the loop head through the back edge; one that grows `hi` there could repeat
  on any number of iterations, so `hi` goes straight to `N` and the next use is
  reported. A loop condition that is the literal `true`, or a `for (;;)` with
  no condition, has no exit edge; it is left only by `break`, `return` or
  `throw`.
- **`try`/`catch`:** a `catch` block's starting state is the join of every
  state the `try` block passes through, since it could throw anywhere.
  `finally` runs on every path.
- **Exits by `throw`:** these are exempt from `not-consumed`. Leaving the
  scope by throwing doesn't require the binding to have been consumed.
- **After an error:** a consumption that is itself a `use-after-move` leaves
  the binding fully consumed, so one mistake doesn't cascade into more
  diagnostics.
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
- **Moving a part:** `pair[0]` or `held.first` used as a move or a consume
  affects that place only (a partial move), counted against that part's own
  grade. Its siblings stay owned. Using a moved place, or a
  place containing it (including the whole container), is a `use-after-move`.
  Reading through a part (`pair[0].id`) is a borrow.
- **Consumed means every part:** a container binding is consumed once it has
  been moved as a whole or each of its linear parts has been consumed as many
  times as its grade. A container that is itself graded and has linear parts
  is checked conservatively: once any of its uses is consumed, its parts count
  as possibly used up.
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
