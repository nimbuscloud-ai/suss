/**
 * The JSX elements a function renders, as the adapter's summary of that
 * function reads them: the ones its own body writes, and the ones a
 * function written inside it writes when that function runs inline,
 * such as the arrow handed to `items.map`. It is `runsCall`'s rule for
 * elements, so a nested declaration's elements are its own. No rule
 * reads the answer; a pack's sub-unit hook does, through the adapter.
 */

import { lit, rule, variable as v } from "@suss/datalog";

import { inSourceOrder } from "./runsCall.js";

import type { Database, Rule } from "@suss/datalog";

/** What a caller asks through to list the elements each function renders. */
export const ELEMENTS_RUN_QUESTION = "wantedElementsRun";

export const RUNS_ELEMENT_RULES: readonly Rule[] = [
  rule(
    "runsElement",
    [v("f"), v("e")],
    [lit("rendersElement", v("f"), v("e"))],
  ),
  rule(
    "runsElement",
    [v("f"), v("e")],
    [
      lit("containsFn", v("f"), v("g")),
      lit("inlineFn", v("g")),
      lit("runsElement", v("g"), v("e")),
    ],
  ),
];

export const RUNS_ELEMENT_QUESTIONS: readonly Rule[] = [
  rule(
    "wantedRunsElement",
    [v("f"), v("e")],
    [lit(ELEMENTS_RUN_QUESTION, v("f")), lit("runsElement", v("f"), v("e"))],
  ),
];

/** The elements a function already asked about through `ELEMENTS_RUN_QUESTION` renders, in source order. */
export function readElementsRun(db: Database, fn: string): string[] {
  return inSourceOrder(
    db.lookup("wantedRunsElement", 0, fn).map((row) => String(row[1])),
  );
}
