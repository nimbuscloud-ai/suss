// resolve.ts: run the shared resolution rules over this project's facts, plus
// the one thing Ruby says differently. The rules live in @suss/resolution and
// are the same ones the other two adapters evaluate.

import { constant, lit, rule, variable as v } from "@suss/datalog";
import {
  allocationSitesOf,
  alsoSteps,
  askResolution,
  askResolutionUnder,
  INSTANCE_STEP,
  resolutionProgram,
  resolutionUnderProgram,
  writtenValueOf as sharedWrittenValueOf,
  writtenValueUnder as sharedWrittenValueUnder,
  VALUE_STEP,
} from "@suss/resolution";

import type { Database } from "@suss/datalog";

/** The steps Ruby states beyond the shared rules. */
export const RUBY_RULES = alsoSteps([
  // Making one of a class is a call of the class, which the shared rules
  // already say. Ruby writes the callee as `new` read off the constant, so
  // what this adds is that the callee is the class.
  rule(
    "hop",
    [v("x"), v("cls"), INSTANCE_STEP],
    [
      lit("readsProperty", v("x"), v("o"), constant("new")),
      lit("comesTo", v("o"), v("cls")),
      lit("objectValue", v("cls")),
    ],
  ),

  // The same spelling again, for the caller asking where a class was
  // made. `callsNamed` reaches a callee written as the name itself, and
  // Ruby writes `new` off the constant instead.
  rule(
    "constructsNamed",
    [v("r"), v("cls")],
    [
      lit("binds", v("o"), v("cls")),
      lit("readsProperty", v("c"), v("o"), constant("new")),
      lit("call", v("r"), v("c")),
    ],
  ),

  // `%i[a b].freeze` is worth the list it was written as. The evaluator
  // says the same in its row table, for a value it reads in one file.
  ...["freeze", "dup"].map((method) =>
    rule(
      "hop",
      [v("r"), v("o"), VALUE_STEP],
      [
        lit("call", v("r"), v("c")),
        lit("readsProperty", v("c"), v("o"), constant(method)),
      ],
      "hands back the receiver",
    ),
  ),
]);

/**
 * The shared rules with Ruby's own, and the questions, as one program.
 * Every question this adapter asks runs over it, so the whole run shares
 * one evaluation state.
 */
export const RUBY_PROGRAM = resolutionProgram(RUBY_RULES);

/** Ask what these values come down to, then derive. */
export function resolveValues(db: Database, keys: readonly string[]): void {
  askResolution(db, keys, "wanted", RUBY_PROGRAM);
}

/**
 * What a value came down to, when the rules settled it on a function.
 * Asked once per call a body makes, so it joins on the index rather
 * than reading every answer the run has given.
 */
export function resolvedFunctions(db: Database, key: string): string[] {
  return db.lookup("wantedResolves", 0, key).map((row) => String(row[1]));
}

/**
 * The single expression a value was written as. A call to a project
 * function is asked about as well, so the answer is what that function
 * returns.
 */
export function writtenValueOf(db: Database, key: string): string | null {
  resolveValues(db, [key]);
  return sharedWrittenValueOf(db, key, (keys) => resolveValues(db, keys));
}

/**
 * The single expression a value was written as when the receiver behind
 * it is the instance one site made. An ivar two constructions fill
 * differently settles here and not context free.
 *
 * A question abandoned on its budget gives back nothing. The pair
 * stays marked as asked, so a second caller gets the same nothing
 * without paying for it again.
 */
export function writtenValueUnder(
  db: Database,
  key: string,
  site: string,
): string | null {
  const outcome = askResolutionUnder(
    db,
    [[key, site]],
    resolutionUnderProgram(RUBY_RULES),
  );
  if (outcome === "abandoned") {
    return null;
  }
  return sharedWrittenValueUnder(db, key, site);
}

/** Every construction of a class the run can see, as the keys to ask under. */
export function constructionSites(db: Database, classKey: string): string[] {
  askResolution(db, [classKey], "wantedSites", RUBY_PROGRAM);
  return allocationSitesOf(db, classKey);
}
