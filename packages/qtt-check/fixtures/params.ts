import { spend } from './_lib.ts';
import type { Token } from './_lib.ts';

export function paramConsumed(t: Token): void {
  spend(t);
}

export function paramNotConsumed(
  t: Token, // error: not-consumed
): void {
  console.log(t.id);
}

export function paramReturned(t: Token): Token {
  return t;
}
