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

/** Where a name came from, for one construction: the module and the name that module exports it under. */
export interface SubjectOrigin {
  module: string;
  name: string;
}

/** The call a value was built by, and where that call's callee came from. */
export interface SubjectConstruction {
  /** The value key of the call, which is the key a router index keys its constructions by. */
  constructionKey: string;
  origins: SubjectOrigin[];
}

/**
 * What each of these values was built by. A value written as exactly one
 * expression, and that expression a call whose callee came out of some
 * module, is a construction; anything else is left out of the result.
 *
 * A value written two different ways is left out rather than settled on
 * one of them, because keying a route on the wrong app is worse than
 * keying it on none.
 */
export function subjectConstructions(
  db: Database,
  valueKeys: readonly string[],
): Map<string, SubjectConstruction> {
  const found = new Map<string, SubjectConstruction>();
  if (valueKeys.length === 0) {
    return found;
  }

  for (const valueKey of valueKeys) {
    db.add("wantedSubject", [valueKey]);
  }
  evaluate(db, RESOLUTION_PROGRAM.rules);

  const writtenAs = new Map<string, Set<string>>();
  for (const row of db.facts("wantedSubjectWritten")) {
    const written = writtenAs.get(String(row[0])) ?? new Set<string>();
    written.add(String(row[1]));
    writtenAs.set(String(row[0]), written);
  }

  const origins = new Map<string, SubjectOrigin[]>();
  for (const row of db.facts("wantedSubjectConstruction")) {
    const key = `${String(row[0])}|${String(row[1])}`;
    const listed = origins.get(key) ?? [];
    listed.push({ module: String(row[2]), name: String(row[3]) });
    origins.set(key, listed);
  }

  for (const valueKey of valueKeys) {
    const written = writtenAs.get(valueKey);
    if (written === undefined || written.size !== 1) {
      continue;
    }
    const constructionKey = [...written][0] as string;
    const from = origins.get(`${valueKey}|${constructionKey}`);
    if (from !== undefined) {
      found.set(valueKey, { constructionKey, origins: from });
    }
  }
  return found;
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
