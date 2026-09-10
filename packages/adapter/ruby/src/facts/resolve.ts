// resolve.ts: run the shared resolution rules over this project's facts, plus
// the one thing Ruby says differently. The rules live in @suss/resolution and
// are the same ones the other two adapters evaluate.

import { constant, lit, rule, variable as v } from "@suss/datalog";
import {
  askResolution,
  resolutionProgram,
  writtenValueOf as sharedWrittenValueOf,
  VALUE_STEP,
} from "@suss/resolution";

import type { Database } from "@suss/datalog";

/** The one step Ruby states beyond the shared rules: `Loader.new`. */
export const RUBY_RULES = [
  // `Loader.new` makes one of the class, which the shared rules already say
  // about calling a class. Ruby writes it as a method read off the constant
  // instead, so the read is what steps to the class here.
  rule(
    "stepsTo",
    [v("x"), v("cls"), VALUE_STEP],
    [
      lit("readsProperty", v("x"), v("o"), constant("new")),
      lit("comesTo", v("o"), v("cls")),
      lit("objectValue", v("cls")),
    ],
  ),
];

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

/** What a value came down to, when the rules settled it on a function. */
export function resolvedFunctions(db: Database, key: string): string[] {
  return db
    .facts("wantedResolves")
    .filter((row) => String(row[0]) === key)
    .map((row) => String(row[1]));
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
