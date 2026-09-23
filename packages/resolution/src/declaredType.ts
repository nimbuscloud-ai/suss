/**
 * The types a value is declared as, for a caller that wants the class
 * of a name the source gives no type.
 *
 * A parameter nobody annotated still has a type when the callers that
 * pass it do. The rules follow each argument back to a declaration,
 * through as many unannotated helpers as the chain has, and report
 * every type they reach. Whether two of those are one type depends on
 * what each key refers to, which the adapter knows, so the keys come
 * back as found. The DESIGN says which callers are checked.
 */

import { askResolution, resolutionProgram } from "./program.js";

import type { Database, OnDemandRules } from "@suss/datalog";

/**
 * Each type key the value is declared as, or none when a caller passes
 * it something no declaration types. A caller passing on a parameter of
 * its own that nothing types makes no claim.
 */
export function declaredTypesOf(
  db: Database,
  key: string,
  program: OnDemandRules = resolutionProgram(),
): string[] {
  askResolution(db, [key], "wantedType", program);
  const excused = new Set([
    ...answersOf(db, "wantedPassedTypedAs", key),
    ...answersOf(db, "wantedPassedParam", key),
  ]);
  const passed = answersOf(db, "wantedTypePassed", key);
  if (passed.some((argument) => !excused.has(argument))) {
    return [];
  }
  return [...new Set(answersOf(db, "wantedTypedAs", key))];
}

/** The second column of an answer relation's rows for one key. */
function answersOf(db: Database, relation: string, key: string): string[] {
  return db.lookup(relation, 0, key).map((row) => String(row[1]));
}
