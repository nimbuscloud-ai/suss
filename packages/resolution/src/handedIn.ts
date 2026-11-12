/**
 * handedIn.ts: the parameters a platform fills when it calls a unit.
 *
 * A Worker's `fetch(request, env)` is handed its bindings in `env`, and
 * nothing in the source says so. The pack that discovers the unit says
 * which parameter it is, and the adapter states `handedIn(p, name)` on
 * that parameter when it claims the unit, before it reads the body. A
 * read chain off `handedIn(name)` then finds every read off it.
 */

import { askResolution } from "./program.js";

import type { Database, OnDemandRules } from "@suss/datalog";

/** A parameter the platform fills, by its position and the name a read chain asks for it under. */
export interface HandedInAt {
  readonly at: number;
  readonly name: string;
}

/**
 * States `handedIn` on the parameter of `func` at each position, from
 * the `paramOf` rows the function's own facts state. Returns whether a
 * row was new, since a rule that reads it has to run again.
 */
export function stateHandedIn(
  db: Database,
  func: string,
  handedIn: readonly HandedInAt[],
): boolean {
  let added = false;
  const parameters = db.lookup("paramOf", 0, func);
  for (const { at, name } of handedIn) {
    for (const row of parameters) {
      if (
        String(row[1]) === String(at) &&
        db.add("handedIn", [String(row[2]), name]) === "added"
      ) {
        added = true;
      }
    }
  }
  return added;
}

/**
 * The names of the handed-in parameters the rules followed into the
 * value at `key`, asked from every parameter stated so far. For an
 * adapter that states a file's facts before it asks anything, as Python
 * and Ruby do; a parameter stated later is asked about when it arrives.
 */
export function handedNamesReaching(
  db: Database,
  key: string,
  program: OnDemandRules,
): string[] {
  const parameters = db.facts("handedIn").map((row) => String(row[0]));
  if (parameters.length === 0) {
    return [];
  }
  askResolution(db, parameters, "wantedHandedObject", program);
  return db
    .lookup("wantedHandedValue", 0, key)
    .flatMap((row) =>
      db
        .lookup("handedIn", 0, String(row[1]))
        .map((handed) => String(handed[1])),
    );
}
