import type { Borrow, Linear } from 'linear-check';

export interface Authorization {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
}

// An authorization holds funds on the customer's card. It must be either
// captured or voided, exactly once: never both, never twice, never forgotten.
export type HeldFunds = Linear<Authorization>;

// Passing a linear value as an argument moves it, so the session's
// operations are methods: calling a method borrows the session instead.
export interface GatewaySession {
  readonly merchantId: string;
  ping(): void;
  authorize(amount: number, currency: string): HeldFunds;
  close(this: Linear<GatewaySession>): void;
}

let nextId = 1;

export function openSession(merchantId: string): Linear<GatewaySession> {
  return {
    merchantId,
    ping() {
      console.log(`[gateway] ping ${merchantId}`);
    },
    authorize(amount, currency) {
      const id = `auth_${nextId++}`;
      console.log(`[${merchantId}] authorized ${id}: ${amount} ${currency}`);
      return { id, amount, currency };
    },
    close() {
      console.log(`[gateway] closed session for ${merchantId}`);
    },
  };
}

// Capture and void are where an authorization's lifetime ends, so they take a
// plain Authorization: passing HeldFunds to them is the caller's move, and
// there's nothing left for them to consume.
export function capture(auth: Authorization): void {
  console.log(`captured ${auth.id}: ${auth.amount} ${auth.currency}`);
}

export function voidAuthorization(auth: Authorization): void {
  console.log(`voided ${auth.id}`);
}

export function captureOrVoid(auth: HeldFunds, inStock: boolean): void {
  if (inStock) {
    capture(auth);
  } else {
    voidAuthorization(auth);
  }
}

// Borrow<…> reads an authorization without taking it: the caller still has to
// capture or void it.
export function describeHold(auth: Borrow<HeldFunds>): string {
  return `${auth.id}: ${auth.amount} ${auth.currency}`;
}
