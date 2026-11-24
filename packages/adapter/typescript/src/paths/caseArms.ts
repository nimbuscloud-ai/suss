/**
 * What one arm of a `switch` tests. The lowering and the ancestor walk
 * write an arm's condition text from this, and the predicate reader
 * writes what the arm compares, so the two always agree.
 *
 * An arm runs when the switch's subject `===` one of its labels. A
 * clause with no statements falls into the next one, so the arm whose
 * body runs also has the labels of the empty clauses stacked above it.
 */

import { type CaseClause, type Expression, Node } from "ts-morph";

export interface CaseArm {
  /** The value the switch is written on. */
  readonly subject: Expression;
  /** Any one of these, compared with `===`, picks the arm. */
  readonly labels: readonly Expression[];
}

/**
 * What a case clause tests. Null for a clause outside a switch, and for
 * one an empty `default` falls into, since that arm runs for any value
 * the other labels miss.
 */
export function caseArmOf(clause: CaseClause): CaseArm | null {
  const switchStatement = clause.getParent()?.getParent();
  if (
    switchStatement === undefined ||
    !Node.isSwitchStatement(switchStatement)
  ) {
    return null;
  }
  const stacked = stackedClauses(clause);
  if (stacked === null) {
    return null;
  }
  return {
    subject: switchStatement.getExpression(),
    labels: stacked.map((one) => one.getExpression()),
  };
}

/** The clause and the empty clauses directly above it, in source order, or null when one of them is a `default`. */
function stackedClauses(clause: CaseClause): CaseClause[] | null {
  const stacked = [clause];
  let previous = clause.getPreviousSibling();
  while (
    previous !== undefined &&
    (Node.isCaseClause(previous) || Node.isDefaultClause(previous)) &&
    previous.getStatements().length === 0
  ) {
    if (Node.isDefaultClause(previous)) {
      return null;
    }

    stacked.unshift(previous);
    previous = previous.getPreviousSibling();
  }
  return stacked;
}

/** The arm's test written as TypeScript would say it, `kind === "a" || kind === "b"`. */
export function caseArmText(arm: CaseArm): string {
  const subject = arm.subject.getText();
  return arm.labels
    .map((label) => `${subject} === ${label.getText()}`)
    .join(" || ");
}
