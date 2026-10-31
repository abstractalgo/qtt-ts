import type { Quantity } from '../src/index.ts';
import {
  cond,
  inspect,
  issue,
  issuePass,
  mint,
  punch,
  punchTwice,
  spend,
} from './_lib.ts';
import type { Ticket } from './_lib.ts';

export function exactlyThree(): void {
  const t = issue();
  punch(t);
  punch(t);
  punch(t);
}

export function tooFew(): void {
  const t = issue(); // error: not-consumed
  punch(t);
  punch(t);
}

export function tooMany(): void {
  const t = issue();
  punch(t);
  punch(t);
  punch(t);
  punch(t); // error: use-after-move
}

export function borrowsAreFree(): void {
  const t = issue();
  console.log(inspect(t), t.id);
  punch(t);
  console.log(inspect(t));
  punchTwice(t);
}

export function borrowAfterLastUse(): void {
  const t = issue();
  punch(t);
  punchTwice(t);
  console.log(t.id); // error: use-after-move
}

export function gradedParameterTakesItsGrade(): void {
  const t = issue();
  punchTwice(t);
  punchTwice(t); // error: use-after-move
}

export function linearValueIntoGradedParameter(): void {
  const t = mint();
  punchTwice(t); // error: use-after-move
}

export function gradedValueIntoLinearParameter(): void {
  const t = issue();
  spend(t);
  spend(t);
  spend(t);
}

export function movedWhole(): Ticket {
  const t = issue();
  return t;
}

export function movedWholeAfterAUse(): Ticket {
  const t = issue();
  punch(t);
  return t; // error: use-after-move
}

export function dropTheRest(): void {
  const t = issue();
  punch(t);
  void t;
}

export function branchesDisagree(): void {
  const t = issue(); // error: not-consumed
  punch(t);
  if (cond()) {
    punchTwice(t);
  } else {
    punch(t);
  }
}

export function branchesAgree(): void {
  const t = issue();
  if (cond()) {
    punch(t);
    punchTwice(t);
  } else {
    punchTwice(t);
    punch(t);
  }
}

export function maybeTooMany(): void {
  const t = issue();
  punchTwice(t);
  if (cond()) {
    punch(t);
  }
  punch(t); // error: use-after-move
}

export function useInLoop(): void {
  const t = issue(); // error: not-consumed
  while (cond()) {
    punch(t); // error: use-after-move
  }
}

export function gradedParameter(t: Quantity<{ readonly id: string }, 2>): void {
  punch(t);
  punch(t);
}

export function gradedParameterUnderused(
  t: Quantity<{ readonly id: string }, 2>, // error: not-consumed
): void {
  punch(t);
}

export function consumingMethods(): void {
  const pass = issuePass();
  pass.ride();
  pass.ride();
}

export function consumingMethodTakesItsGrade(): void {
  const pass = issuePass();
  pass.ride();
  pass.rideTwice(); // error: use-after-move
}

export function gradedPartOfATuple(): void {
  const pair = [issue(), mint()] as const;
  punch(pair[0]);
  punchTwice(pair[0]);
  spend(pair[1]);
}

export function gradedPartUnderused(): void {
  const pair = [issue(), mint()] as const; // error: not-consumed
  punch(pair[0]);
  spend(pair[1]);
}

export function genericIdentityTakesEverything(): Ticket {
  const t = issue();
  punch(t);
  return identity(t); // error: use-after-move
}

declare function identity<T>(value: T): T;
