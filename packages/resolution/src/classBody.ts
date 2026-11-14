/**
 * The calls a class body makes outside every method, as a library that
 * declares things there reads them: `has_many :items` in a Rails model,
 * `scope :recent, -> { ... }`, or a call inside `included do ... end`.
 *
 * Every adapter states the call statements of a body in order as
 * `bodyCallAt`, a class's among them, and Ruby links a call to the block
 * it is written with by `callBlock`. A call inside such a block runs
 * when the class body does, so the rule follows each block down. A call
 * inside a method, a lambda or a nested class belongs to that, and none
 * of them is a block. DESIGN.md, under "The calls a class body makes",
 * has the facts.
 */

import { lit, rule, variable as v } from "@suss/datalog";

import { bySourceOrder } from "./nodeKey.js";
import { askResolution, resolutionProgram } from "./program.js";

import type { Database, OnDemandRules, Rule } from "@suss/datalog";

/** What a caller asks through to list the calls each class body makes. */
export const CLASS_BODY_QUESTION = "wantedClassBody";

export const CLASS_BODY_RULES: readonly Rule[] = [
  rule(
    "classBodyCall",
    [v("c"), v("r")],
    [lit("bodyCallAt", v("c"), v("k"), v("r")), lit("objectValue", v("c"))],
  ),
  rule(
    "classBodyCall",
    [v("c"), v("r")],
    [
      lit("classBodyCall", v("c"), v("outer")),
      lit("callBlock", v("outer"), v("b")),
      lit("bodyCallAt", v("b"), v("k"), v("r")),
    ],
  ),
];

export const CLASS_BODY_QUESTIONS: readonly Rule[] = [
  rule(
    "wantedClassBodyCall",
    [v("c"), v("r")],
    [lit(CLASS_BODY_QUESTION, v("c")), lit("classBodyCall", v("c"), v("r"))],
  ),
];

/**
 * The calls each of these classes makes in its body, in the order the
 * source writes them. One question for the batch, so the rules are
 * evaluated once.
 */
export function classBodyCalls(
  db: Database,
  classes: readonly string[],
  program: OnDemandRules = resolutionProgram(),
): Map<string, string[]> {
  if (classes.length > 0) {
    askResolution(db, classes, CLASS_BODY_QUESTION, program);
  }
  return new Map(classes.map((cls) => [cls, readClassBodyCalls(db, cls)]));
}

/** The calls a class already asked about through `CLASS_BODY_QUESTION` makes, in source order. */
export function readClassBodyCalls(db: Database, cls: string): string[] {
  const calls = [
    ...new Set(
      db.lookup("wantedClassBodyCall", 0, cls).map((row) => String(row[1])),
    ),
  ];
  return calls.sort(bySourceOrder);
}
