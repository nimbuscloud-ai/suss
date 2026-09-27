/**
 * The functions whose return becomes the process's exit code, for an
 * adapter that found the values ending up as the code itself: the
 * argument an exit call hands over, or what is assigned to the code.
 * DESIGN.md says how the walk gets from a value to a function.
 */

import { askResolution, resolutionProgram } from "./program.js";

import type { Database, OnDemandRules } from "@suss/datalog";

/** Each function key a call at or reached from one of these values invokes. */
export function exitCodeFunctions(
  db: Database,
  sinks: readonly string[],
  program: OnDemandRules = resolutionProgram(),
): Set<string> {
  if (sinks.length === 0) {
    return new Set();
  }
  askResolution(db, sinks, "wantedExitSink", program);
  const found = new Set<string>();
  for (const sink of sinks) {
    for (const row of db.lookup("wantedExitCodeFrom", 0, sink)) {
      found.add(String(row[1]));
    }
  }
  return found;
}
