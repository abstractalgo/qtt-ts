import { mint, spend } from './_lib.ts';

export function moveInTryThenCatch(): void {
  const t = mint();
  try {
    spend(t);
  } catch {
    spend(t); // error: use-after-move
  }
}

export function consumedInFinally(): void {
  const t = mint();
  try {
    console.log(t.id);
  } finally {
    spend(t);
  }
}
