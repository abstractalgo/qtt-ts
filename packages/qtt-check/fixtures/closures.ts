import { mint, spend } from './_lib.ts';

export function captured(): void {
  const t = mint();
  const later = () => spend(t); // error: captured
  later();
}

export function ownedInsideClosure(): void {
  const run = () => {
    const t = mint();
    spend(t);
  };
  run();
}
