import { cond, mint, spend } from './_lib.ts';

export function moveInLoop(): void {
  const t = mint(); // error: not-consumed
  while (cond()) {
    spend(t); // error: use-after-move
  }
}

export function freshEachIteration(): void {
  while (cond()) {
    const t = mint();
    spend(t);
  }
}

export function moveThenBreak(): void {
  const t = mint();
  while (true) {
    if (cond()) {
      spend(t);
      break;
    }
  }
}

export function breakWithoutConsuming(): void {
  while (cond()) {
    const t = mint(); // error: not-consumed
    if (cond()) {
      break;
    }
    spend(t);
  }
}
