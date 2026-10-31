declare const quantityBrand: unique symbol;
declare const borrowBrand: unique symbol;

/**
 * The brand's payload: one optional key per count, plus a key every count shares. The shared key keeps
 * `Quantity<T, 3>` and `Quantity<T, 1>` assignable to each other, so the checker, not TypeScript, decides
 * whether a use fits in what's left.
 */
interface Uses {
  readonly uses?: true;
}

/** A value that must be consumed exactly `N` times. Type-only, erased at compile time. */
export type Quantity<T, N extends number> = T & {
  readonly [quantityBrand]?: Uses & { readonly [K in `${N}`]?: true };
};

/** A value that must be consumed exactly once: `Quantity<T, 1>`. Type-only, erased at compile time. */
export type Linear<T> = Quantity<T, 1>;

/** A parameter that reads a linear value without taking ownership of it. Type-only, erased at compile time. */
export type Borrow<T> = T & { readonly [borrowBrand]?: true };
