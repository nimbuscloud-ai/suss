/**
 * The calls a function's body runs, as the adapter's summary of that
 * function reads them.
 *
 * Every adapter states the calls written in a function's own body as
 * `makesCall`, and links a function written inside another with
 * `containsFn`. Whether the inner function runs as part of the outer one
 * is a language's call: a TypeScript arrow passed to `.then` does, and a
 * nested `function` declaration is a unit of its own. `inlineFn` says
 * which, so one rule gives the same list in every language. A pack that
 * claims a callback as a unit of its own reads its parent's calls from
 * here. DESIGN.md, under "The calls a body runs", has the facts.
 */

import { lit, rule, variable as v } from "@suss/datalog";

import { bySourceOrder } from "./nodeKey.js";
import { askResolution, resolutionProgram } from "./program.js";

import type { Database, OnDemandRules, Rule } from "@suss/datalog";

/** What a caller asks through to list the calls each function runs. */
export const CALLS_RUN_QUESTION = "wantedCallsRun";

export const RUNS_CALL_RULES: readonly Rule[] = [
  rule("runsCall", [v("f"), v("r")], [lit("makesCall", v("f"), v("r"))]),
  rule(
    "runsCall",
    [v("f"), v("r")],
    [
      lit("containsFn", v("f"), v("g")),
      lit("inlineFn", v("g")),
      lit("runsCall", v("g"), v("r")),
    ],
  ),
];

export const RUNS_CALL_QUESTIONS: readonly Rule[] = [
  rule(
    "wantedRunsCall",
    [v("f"), v("r")],
    [lit(CALLS_RUN_QUESTION, v("f")), lit("runsCall", v("f"), v("r"))],
  ),
];

/**
 * The calls each of these functions runs, in the order the source writes
 * them. One question for the batch, so the rules are evaluated once.
 */
export function callsRun(
  db: Database,
  functions: readonly string[],
  program: OnDemandRules = resolutionProgram(),
): Map<string, string[]> {
  if (functions.length > 0) {
    askResolution(db, functions, CALLS_RUN_QUESTION, program);
  }
  return new Map(functions.map((fn) => [fn, readCallsRun(db, fn)]));
}

/**
 * The calls a function already asked about through `CALLS_RUN_QUESTION`
 * runs, in source order: by where each call starts, and a call around
 * another before it, which is the order a walk down the tree reaches
 * them. A key that is not a node comes last.
 */
export function readCallsRun(db: Database, fn: string): string[] {
  return inSourceOrder(
    db.lookup("wantedRunsCall", 0, fn).map((row) => String(row[1])),
  );
}

/** Each key once, in the order `readCallsRun` gives calls in. */
export function inSourceOrder(keys: Iterable<string>): string[] {
  return [...new Set(keys)].sort(bySourceOrder);
}
