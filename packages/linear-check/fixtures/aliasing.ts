import { mint, spend } from './_lib.ts';

export function moveToAlias(): void {
  const t = mint();
  const u = t;
  spend(u);
}

export function useOriginalAfterAlias(): void {
  const t = mint();
  const u = t;
  spend(t); // error: use-after-move
  spend(u);
}

export function aliasNotConsumed(): void {
  const t = mint();
  const u = t; // error: not-consumed
  console.log(u.id);
}

export function reassignWhileOwned(): void {
  let t = mint();
  t = mint(); // error: overwritten
  spend(t);
}

export function reassignAfterMove(): void {
  let t = mint();
  spend(t);
  t = mint();
  spend(t);
}

export function destructuringBorrows(): void {
  const t = mint();
  const { id } = t;
  console.log(id);
  spend(t);
}

export function movedIntoContainer(): unknown {
  const t = mint();
  return { t };
}
