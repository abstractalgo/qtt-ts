import { mint, spend } from './_lib.ts';
import type { Token } from './_lib.ts';

export function consumedOnce(): void {
  const t = mint();
  spend(t);
}

export function neverConsumed(): void {
  const t = mint(); // error: not-consumed
  console.log(t.id);
}

export function consumedTwice(): void {
  const t = mint();
  spend(t);
  spend(t); // error: use-after-move
}

export function borrowAfterMove(): void {
  const t = mint();
  spend(t);
  console.log(t.id); // error: use-after-move
}

export function annotated(): void {
  const t: Token = mint();
  spend(t);
}

export function explicitDrop(): void {
  const t = mint();
  void t;
}
