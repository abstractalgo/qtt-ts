import type { Borrow } from '../src/index.ts';
import { mint, peek, spend } from './_lib.ts';
import type { Token } from './_lib.ts';

export function borrowKeepsOwnership(): void {
  const t = mint();
  console.log(peek(t));
  spend(t);
}

export function borrowAfterMove(): void {
  const t = mint();
  spend(t);
  console.log(peek(t)); // error: use-after-move
}

export function borrowedParamIsRead(t: Borrow<Token>): string {
  return t.id;
}

export function borrowedParamPassedOn(t: Borrow<Token>): string {
  return peek(t);
}

export function borrowedParamMoved(t: Borrow<Token>): void {
  spend(t); // error: moved-borrow
}

export function borrowedParamReturned(t: Borrow<Token>): Token {
  return t; // error: moved-borrow
}

export function borrowedParamCaptured(t: Borrow<Token>): () => string {
  return () => t.id;
}
