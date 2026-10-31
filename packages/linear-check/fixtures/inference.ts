import { mint, spend } from './_lib.ts';
import type { Token } from './_lib.ts';

function identity<T>(value: T): T {
  return value;
}

export function throughGeneric(): void {
  const t = identity(mint()); // error: not-consumed
  console.log(t.id);
}

export function fromArray(tokens: readonly Token[]): void {
  const t = tokens[0]; // error: move-out-of-index, not-consumed
  console.log(t?.id);
}

export function promised(p: Promise<Token>): Promise<void> {
  return p.then((t) => spend(t));
}
