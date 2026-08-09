// resolve.ts: run the shared resolution rules over this project's facts.
// The rules live in @suss/resolution and are the same ones the TypeScript
// adapter evaluates, so a Python value is followed the way any value is.

import { evaluate } from "@suss/datalog";
import { RESOLUTION_QUESTIONS, RESOLUTION_RULES } from "@suss/resolution";

import type { Database } from "@suss/datalog";

/**
 * Ask what every call in the project comes down to, then derive. The
 * questions are what let the engine follow a chain only where somebody is
 * waiting on the answer, so a caller has to write its question down first.
 */
export function resolveValues(db: Database): void {
  for (const [callKey] of db.facts("call")) {
    if (callKey !== undefined) {
      db.add("wanted", [callKey]);
    }
  }

  evaluate(db, [...RESOLUTION_RULES, ...RESOLUTION_QUESTIONS]);
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
  const row = db.facts("objectOf").find((entry) => entry[0] === callKey);
  return row === undefined ? null : String(row[1]);
}
