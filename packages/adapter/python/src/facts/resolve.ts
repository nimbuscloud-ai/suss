// resolve.ts: run the shared resolution rules over this project's facts.
// The rules live in @suss/resolution and are the same ones the TypeScript
// adapter evaluates, so a Python value is followed the way any value is.

import { deriveOnDemand, evaluate } from "@suss/datalog";
import {
  ANSWER_RELATIONS,
  RESOLUTION_QUESTIONS,
  RESOLUTION_RULES,
} from "@suss/resolution";

import type { Database } from "@suss/datalog";

/**
 * The rules rewritten so a relation is derived only where a question reaches
 * it. Built once, because the rewrite does not depend on the facts.
 */
const RESOLUTION_PROGRAM = deriveOnDemand(
  [...RESOLUTION_RULES, ...RESOLUTION_QUESTIONS],
  ANSWER_RELATIONS,
);

/**
 * Ask what these calls come down to, then derive. Asking about every call in
 * a project costs seconds on a large one and answers questions nobody has,
 * so a caller names the handful it needs.
 */
export function resolveCalls(db: Database, callKeys: readonly string[]): void {
  if (callKeys.length === 0) {
    return;
  }

  for (const callKey of callKeys) {
    db.add("wanted", [callKey]);
  }

  evaluate(db, RESOLUTION_PROGRAM.rules);
}

/**
 * The values an object contains under its own keys, in the order the source
 * writes them. Empty when nothing said what the object contains.
 */
export function containedValues(db: Database, objectKey: string): string[] {
  return db
    .facts("holdsProperty")
    .filter((row) => row[0] === objectKey)
    .map((row) => [String(row[1]), String(row[2])] as const)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, value]) => value);
}

/** What a call comes down to, when the rules settled it on an object. */
export function objectReturnedBy(db: Database, callKey: string): string | null {
  const row = db.facts("wantedObjectOf").find((entry) => entry[0] === callKey);
  return row === undefined ? null : String(row[1]);
}
