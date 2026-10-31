import type { Borrow, Linear, Quantity } from 'qtt-check';

export interface Authorization {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
}

// An authorization holds funds on the customer's card. It must be either
// captured or voided, exactly once: never both, never twice, never forgotten.
export type HeldFunds = Linear<Authorization>;

// An order shipped in parts holds the whole amount up front, and each shipment
// settles its share: captured when it ships, released when it's cancelled.
// With N shipments, the authorization must be settled exactly N times.
export type SplitFunds<N extends number> = Quantity<Authorization, N>;

// Passing a linear value as an argument moves it, so the session's
// operations are methods: calling a method borrows the session instead.
export interface GatewaySession {
  readonly merchantId: string;
  ping(): void;
  authorize(amount: number, currency: string): HeldFunds;
  authorizeSplit<N extends number>(
    amount: number,
    currency: string,
    shipments: N,
  ): SplitFunds<N>;
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
    authorizeSplit(amount, currency, shipments) {
      const id = `auth_${nextId++}`;
      console.log(
        `[${merchantId}] authorized ${id}: ${amount} ${currency} over ${shipments} shipments`,
      );
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

// Each shipment settles one use of a split authorization: the parameter is a
// plain Authorization, so passing SplitFunds<N> consumes one of its N uses.
export function captureShipment(auth: Authorization, amount: number): void {
  console.log(`captured ${amount} ${auth.currency} of ${auth.id}`);
}

export function cancelShipment(auth: Authorization, amount: number): void {
  console.log(`released ${amount} ${auth.currency} of ${auth.id}`);
}
