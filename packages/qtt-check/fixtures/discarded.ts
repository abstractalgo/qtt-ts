import { mint } from './_lib.ts';

export function discarded(): void {
  mint(); // error: discarded
}

export function explicitlyDropped(): void {
  void mint();
}
