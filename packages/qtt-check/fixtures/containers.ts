import { mint, spend, spendMaybe } from './_lib.ts';
import type { Token } from './_lib.ts';

export function tupleBothSpent(): void {
  const pair = [mint(), mint()] as const;
  spend(pair[0]);
  spend(pair[1]);
}

export function tupleDoubleSpend(): void {
  const pair = [mint(), mint()] as const;
  spend(pair[0]);
  spend(pair[0]); // error: use-after-move
  spend(pair[1]);
}

export function tuplePartlyConsumed(): void {
  const pair = [mint(), mint()] as const; // error: not-consumed
  spend(pair[0]);
}

export function readThroughPart(): void {
  const pair = [mint(), mint()] as const;
  console.log(pair[0].id);
  spend(pair[0]);
  spend(pair[1]);
}

export function wholeAfterPart(): readonly [Token, Token] {
  const pair = [mint(), mint()] as const;
  spend(pair[0]);
  return pair; // error: use-after-move
}

export function movedAsWhole(): readonly [Token, Token] {
  const pair = [mint(), mint()] as const;
  return pair;
}

export function destructured(): void {
  const pair = [mint(), mint()] as const;
  const [a, b] = pair;
  spend(a);
  spend(b);
}

export function destructuredThenReused(): void {
  const pair = [mint(), mint()] as const;
  const [a, b] = pair;
  spend(a);
  spend(b);
  spend(pair[0]); // error: use-after-move
}

export function destructuredOnePart(): void {
  const pair = [mint(), mint()] as const; // error: not-consumed
  const [a] = pair;
  spend(a);
}

export function objectFields(): void {
  const held = { first: mint(), second: mint(), label: 'x' };
  console.log(held.label);
  spend(held.first);
  spend(held.second);
}

export function objectFieldForgotten(): void {
  const held = { first: mint(), second: mint() }; // error: not-consumed
  spend(held.first);
}

export function computedIndex(i: 0 | 1): void {
  const pair = [mint(), mint()] as const;
  spend(pair[i]); // error: move-out-of-index
}

export function arrayIndex(tokens: readonly Token[]): void {
  spendMaybe(tokens[0]); // error: move-out-of-index
}

export function arrayIterated(tokens: readonly Token[]): void {
  for (const t of tokens) {
    spend(t);
  }
}

export function arrayIteratedNotConsumed(tokens: readonly Token[]): void {
  for (const t of tokens // error: not-consumed
  ) {
    console.log(t.id);
  }
}

export function arrayParamNotConsumed(
  tokens: readonly Token[], // error: not-consumed
): void {
  console.log(tokens.length);
}
