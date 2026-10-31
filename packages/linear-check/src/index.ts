declare const linearBrand: unique symbol;
declare const borrowBrand: unique symbol;

/** A value that must be consumed exactly once. Type-only, erased at compile time. */
export type Linear<T> = T & { readonly [linearBrand]?: true };

/** A parameter that reads a linear value without taking ownership of it. Type-only, erased at compile time. */
export type Borrow<T> = T & { readonly [borrowBrand]?: true };
