// resolve.ts: run the shared resolution rules over this project's facts, plus
// the one thing Ruby says differently. The rules live in @suss/resolution and
// are the same ones the other two adapters evaluate.

import {
  constant,
  deriveOnDemand,
  evaluate,
  lit,
  rule,
  variable as v,
} from "@suss/datalog";
import {
  ANSWER_RELATIONS,
  RESOLUTION_QUESTIONS,
  RESOLUTION_RULES,
  VALUE_STEP,
} from "@suss/resolution";

import type { Database } from "@suss/datalog";

const RUBY_RULES = [
  // `Loader.new` makes one of the class, which the shared rules already say
  // about calling a class. Ruby writes it as a method read off the constant
  // instead, so the read is what steps to the class here.
  rule(
    "stepsTo",
    [v("x"), v("cls"), VALUE_STEP],
    [
      lit("readsProperty", v("x"), v("o"), constant("new")),
      lit("comesTo", v("o"), v("cls")),
      lit("objectValue", v("cls")),
    ],
  ),
];

/**
 * The rules rewritten so a relation is derived only where a question reaches
 * it. Built once, because the rewrite does not depend on the facts.
 */
const RESOLUTION_PROGRAM = deriveOnDemand(
  [...RESOLUTION_RULES, ...RUBY_RULES, ...RESOLUTION_QUESTIONS],
  ANSWER_RELATIONS,
);

/**
 * Ask what these values come down to, then derive. Asking about everything in
 * a project costs seconds on a large one and answers questions nobody has, so
 * a caller says which handful it needs.
 */
export function resolveValues(db: Database, keys: readonly string[]): void {
  if (keys.length === 0) {
    return;
  }

  for (const key of keys) {
    db.add("wanted", [key]);
  }

  evaluate(db, RESOLUTION_PROGRAM.rules);
}

/** What a value came down to, when the rules settled it on a function. */
export function resolvedFunctions(db: Database, key: string): string[] {
  return db
    .facts("wantedResolves")
    .filter((row) => String(row[0]) === key)
    .map((row) => String(row[1]));
}
