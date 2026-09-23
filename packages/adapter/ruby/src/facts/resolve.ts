/**
 * Runs the shared rules from `@suss/resolution` over this project's facts,
 * with the few steps Ruby writes differently. The other two adapters run
 * the same shared rules.
 */

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

/** The steps Ruby needs beyond the shared rules. */
export const RUBY_RULES = alsoSteps([
  // The shared rules treat a call of a class as making an instance of it.
  // Ruby writes that call as `new` read off the constant, so this step
  // takes the class as the callee.
  rule(
    "hop",
    [v("x"), v("cls"), INSTANCE_STEP],
    [
      lit("readsProperty", v("x"), v("o"), constant("new")),
      lit("comesTo", v("o"), v("cls")),
      lit("objectValue", v("cls")),
    ],
  ),

  // The same `Klass.new` spelling, for a caller asking where a class is
  // constructed. `callsNamed` only matches a callee written as the class
  // name itself.
  rule(
    "constructsNamed",
    [v("r"), v("cls")],
    [
      lit("binds", v("o"), v("cls")),
      lit("readsProperty", v("c"), v("o"), constant("new")),
      lit("call", v("r"), v("c")),
    ],
  ),

  // `%i[a b].freeze` evaluates to the list it was called on. The
  // evaluator's row table has the same step for a value inside one file.
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
 * The shared rules, Ruby's own steps and the questions, built as one
 * program. Every question the adapter asks runs over it, so the whole
 * run shares one evaluation state.
 */
export const RUBY_PROGRAM = resolutionProgram(RUBY_RULES);

/** Asks what these values come down to, and adds the answers to `db`. */
export function resolveValues(db: Database, keys: readonly string[]): void {
  askResolution(db, keys, "wanted", RUBY_PROGRAM);
}

/**
 * Asks which parameters end up naming a variable read off each of these
 * environment objects. A project writes `ENV` in a handful of places and
 * has thousands of callee parameters, so starting from the objects takes
 * one question instead of one per parameter.
 */
export function resolveEnvObjects(
  db: Database,
  objects: readonly string[],
): void {
  askResolution(db, objects, "wantedEnvObject", RUBY_PROGRAM);
}

/**
 * Every function that runs when a value is called: the function the
 * value comes down to, and the one a factory returned when the value was
 * assigned from a call. This runs once per call in a body, so it looks
 * up the index instead of scanning every answer the run has derived.
 */
export function resolvedFunctions(db: Database, key: string): string[] {
  return [
    ...db.lookup("wantedResolves", 0, key),
    ...db.lookup("wantedGivesBack", 0, key),
  ].map((row) => String(row[1]));
}

/**
 * The single expression a value was written as. When the value is a call
 * to a project function, the answer is what that function returns.
 */
export function writtenValueOf(db: Database, key: string): string | null {
  resolveValues(db, [key]);
  return sharedWrittenValueOf(db, key, (keys) => resolveValues(db, keys));
}

/**
 * The single expression a value was written as, when its receiver is the
 * instance one construction site made. An instance variable that two
 * constructions set differently settles here, though it settles on
 * nothing without the site.
 *
 * A question stopped by its budget returns null. The pair stays marked as
 * asked, so a second caller also gets null without paying for it again.
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
