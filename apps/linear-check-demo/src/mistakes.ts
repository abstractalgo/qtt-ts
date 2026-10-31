// Intentional mistakes, one per diagnostic. Never run: main.ts doesn't import
// this file. Both checkers should flag each marked line.
import { capture, openSession, voidAuthorization } from './payments.ts';
import type { GatewaySession, HeldFunds } from './payments.ts';

declare const session: GatewaySession;

export function doubleCapture(): void {
  const auth = session.authorize(10, 'EUR');
  capture(auth);
  capture(auth); // error: use-after-move
}

export function captureThenVoid(): void {
  const auth = session.authorize(10, 'EUR');
  capture(auth);
  voidAuthorization(auth); // error: use-after-move
}

export function forgottenOnEarlyReturn(outOfStock: boolean): void {
  const auth = session.authorize(10, 'EUR'); // error: not-consumed
  if (outOfStock) {
    return;
  }
  capture(auth);
}

export function readAfterCapture(): void {
  const auth = session.authorize(10, 'EUR');
  capture(auth);
  console.log(auth.id); // error: use-after-move
}

export function capturedInCallback(): void {
  const auth = session.authorize(10, 'EUR');
  setTimeout(() => capture(auth), 1000); // error: captured
}

export function overwritten(): void {
  let auth = session.authorize(10, 'EUR');
  auth = session.authorize(20, 'EUR'); // error: overwritten
  capture(auth);
}

export function discarded(): void {
  session.authorize(10, 'EUR'); // error: discarded
}

export function captureInRetryLoop(attempts: number): void {
  const auth = session.authorize(10, 'EUR'); // error: not-consumed
  for (let i = 0; i < attempts; i++) {
    capture(auth); // error: use-after-move
  }
}

export function sessionLeftOpen(): void {
  const s = openSession('merchant_7'); // error: not-consumed
  s.ping();
}

export function receivedButIgnored(
  auth: HeldFunds, // error: not-consumed
): void {
  console.log(auth.amount);
}

export function useAfterMove(): void {
  const auth = session.authorize(10, 'EUR');
  const a = auth;
  capture(a);
  capture(auth); // error: use-after-move
}

export function checkStuff(): void {
  const auth = session.authorize(10, 'EUR');

  const blabla = (auth: HeldFunds): void => {
    console.log(auth.currency);
    capture(auth);
  };

  blabla(auth);
  capture(auth); // error: use-after-move
}

export function checkStuff2(): void {
  const auths = [
    session.authorize(10, 'EUR'),
    session.authorize(20, 'EUR'),
  ] as const;

  capture(auths[0]);
  capture(auths[0]); // error: use-after-move
  capture(auths[1]);
  capture(auths[1]); // error: use-after-move
}

export function checkStuff3(): void {
  const a = {
    bla: session.authorize(10, 'EUR'),
    ble: session.authorize(20, 'EUR'),
  };

  capture(a.bla);
  capture(a.bla); // error: use-after-move
  capture(a.ble);
  capture(a.ble); // error: use-after-move
}
