import { open } from './_lib.ts';

export function closeConsumes(): void {
  const s = open();
  s.refresh();
  s.close();
}

export function useAfterClose(): void {
  const s = open();
  s.close();
  console.log(s.id); // error: use-after-move
}

export function neverClosed(): void {
  const s = open(); // error: not-consumed
  s.refresh();
}
