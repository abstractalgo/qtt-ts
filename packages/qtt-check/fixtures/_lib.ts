// Shared declarations for the fixtures. Never run, only analysed.
import type { Borrow, Linear, Quantity } from '../src/index.ts';

export type Token = Linear<{ readonly id: string }>;

export declare function mint(): Token;
export declare function spend(token: Token): void;
export declare function spendMaybe(token: Token | undefined): void;
export declare function peek(token: Borrow<Token>): string;
export declare function cond(): boolean;

export interface Session {
  readonly id: string;
  refresh(): void;
  close(this: Linear<Session>): void;
}

export declare function open(): Linear<Session>;

// A ticket for three rides: it must be punched exactly three times.
export type Ticket = Quantity<{ readonly id: string }, 3>;

export declare function issue(): Ticket;
/** A plain parameter takes one use. */
export declare function punch(ticket: { readonly id: string }): void;
/** A graded parameter takes as many uses as its grade. */
export declare function punchTwice(
  ticket: Quantity<{ readonly id: string }, 2>,
): void;
export declare function inspect(ticket: Borrow<Ticket>): string;

export interface Pass {
  readonly id: string;
  ride(this: Linear<Pass>): void;
  rideTwice(this: Quantity<Pass, 2>): void;
}

export declare function issuePass(): Quantity<Pass, 2>;
