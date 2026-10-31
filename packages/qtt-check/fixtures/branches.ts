// These fixtures use expressions as statements on purpose.
/* oxlint-disable no-unused-expressions */
import { cond, mint, spend } from './_lib.ts';
import type { Token } from './_lib.ts';

export function bothBranches(): void {
  const t = mint();
  if (cond()) {
    spend(t);
  } else {
    spend(t);
  }
}

export function oneBranch(): void {
  const t = mint(); // error: not-consumed
  if (cond()) {
    spend(t);
  }
}

export function maybeMovedThenUsed(): void {
  const t = mint();
  if (cond()) {
    spend(t);
  }
  spend(t); // error: use-after-move
}

export function earlyReturn(): void {
  const t = mint(); // error: not-consumed
  if (cond()) {
    return;
  }
  spend(t);
}

export function returnMoves(): Token {
  const t = mint();
  return t;
}

export function ternary(): void {
  const t = mint();
  cond() ? spend(t) : spend(t);
}

export function shortCircuit(): void {
  const t = mint(); // error: not-consumed
  cond() && spend(t);
}

export function switchAllCases(n: number): void {
  const t = mint();
  switch (n) {
    case 0:
      spend(t);
      break;
    default:
      spend(t);
  }
}

export function switchMissingDefault(n: number): void {
  const t = mint(); // error: not-consumed
  switch (n) {
    case 0:
      spend(t);
      break;
  }
}

export function throwIsExempt(): void {
  const t = mint();
  if (cond()) {
    throw new Error('nope');
  }
  spend(t);
}
