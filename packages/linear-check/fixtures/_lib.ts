// Shared declarations for the fixtures. Never run, only analysed.
import type { Borrow, Linear } from '../src/index.ts';

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
