/**
 * Whether a value leaves the expressions it is read in: returned, handed
 * to a call, given to another name or object, and so on, each from one
 * fact an adapter states about the read. A router reader asks it about an
 * app its own function builds, since a mount on an app nothing can reach
 * serves nothing. DESIGN.md lists the facts and says why a method call
 * gets a relation of its own.
 *
 * The rules cannot say "no read passes it on", because the demand rewrite
 * refuses negation. So a caller asks the positive question and treats a
 * missing row as the value staying put. A read with no fact behind it
 * looks the same as no read, which is why every spelling needs a fact.
 */

import { lit, rule, variable as v } from "@suss/datalog";

import type { Database, Rule } from "@suss/datalog";

/** What a caller asks through, `askResolution(db, keys, USES_QUESTION)`, to learn where the value at each key goes. */
export const USES_QUESTION = "wantedUses";

/** A rule for each fact that hands the value at x on, then the two that hand on a part of it. */
export const PASSED_ON_RULES: readonly Rule[] = [
  rule("passedOn", [v("x")], [lit("returnsValue", v("f"), v("x"))], "returned"),
  rule("passedOn", [v("x")], [lit("yieldsValue", v("f"), v("x"))], "yielded"),
  rule(
    "passedOn",
    [v("x")],
    [lit("callArg", v("r"), v("k"), v("x"))],
    "an argument",
  ),
  rule(
    "passedOn",
    [v("x")],
    [lit("callKeywordArg", v("r"), v("k"), v("x"))],
    "a keyword argument",
  ),
  rule("passedOn", [v("x")], [lit("binds", v("y"), v("x"))], "another name"),
  rule(
    "passedOn",
    [v("x")],
    [lit("endsHolding", v("y"), v("x"))],
    "another name's last write",
  ),
  rule(
    "passedOn",
    [v("x")],
    [lit("mayHold", v("y"), v("x"))],
    "one of another name's writes",
  ),
  rule(
    "passedOn",
    [v("x")],
    [lit("holdsProperty", v("o"), v("n"), v("x"))],
    "held by an object",
  ),
  rule(
    "passedOn",
    [v("x")],
    [lit("storesProperty", v("o"), v("n"), v("x"), v("k"))],
    "stored on an object",
  ),
  rule(
    "passedOn",
    [v("x")],
    [lit("holdsUnderKey", v("o"), v("x"))],
    "stored under a key",
  ),
  rule(
    "passedOn",
    [v("x")],
    [lit("readsKeyed", v("r"), v("o"), v("x"))],
    "used as a key",
  ),
  rule("passedOn", [v("x")], [lit("entersValue", v("x"))], "entered"),
  rule(
    "passedOn",
    [v("x")],
    [lit("entersAs", v("y"), v("x"))],
    "entered under a name",
  ),
  rule(
    "passedOn",
    [v("x")],
    [lit("paramDefault", v("p"), v("x"))],
    "a parameter default",
  ),
  rule(
    "passedOn",
    [v("x")],
    [lit("fallbackBranch", v("e"), v("x"))],
    "a fallback branch",
  ),
  rule(
    "passedOn",
    [v("x")],
    [lit("conditionalBranch", v("e"), v("x"))],
    "a conditional branch",
  ),
  // `app.router` and `app[key]` hand out a part of the value, so the value
  // goes wherever that part goes. This rule skips a part called at once,
  // `app.run()`, which `wantedCalledMethod` lists instead.
  rule(
    "passedOn",
    [v("x")],
    [lit("readsProperty", v("r"), v("x"), v("n")), lit("passedOn", v("r"))],
    "a property passed on",
  ),
  rule(
    "passedOn",
    [v("x")],
    [lit("readsKeyed", v("r"), v("x"), v("k")), lit("passedOn", v("r"))],
    "an entry passed on",
  ),
];

/**
 * What `wantedUses(x)` derives. Calling the value itself counts as passing
 * it on, since the call hands it whatever the caller had, as a serverless
 * handler does with the request.
 */
export const USES_QUESTIONS: readonly Rule[] = [
  rule(
    "wantedPassedOn",
    [v("x")],
    [lit(USES_QUESTION, v("x")), lit("passedOn", v("x"))],
  ),
  rule(
    "wantedPassedOn",
    [v("x")],
    [lit(USES_QUESTION, v("x")), lit("call", v("r"), v("x"))],
  ),
  rule(
    "wantedCalledMethod",
    [v("x"), v("n")],
    [
      lit(USES_QUESTION, v("x")),
      lit("readsProperty", v("r"), v("x"), v("n")),
      lit("call", v("c"), v("r")),
    ],
  ),
];

/** What the reads of one value do with it. */
export interface ValueUses {
  /** Whether some read passes it on, or calls it. */
  passedOn: boolean;
  /** The methods called on it, `use` for `app.use(...)`, each once. */
  methodsCalled: readonly string[];
}

/** What the rules derived for one key, read after the question was asked. */
export function readUses(db: Database, key: string): ValueUses {
  return {
    passedOn: db.lookup("wantedPassedOn", 0, key).length > 0,
    methodsCalled: [
      ...new Set(
        db.lookup("wantedCalledMethod", 0, key).map((row) => String(row[1])),
      ),
    ],
  };
}

/**
 * Whether a value stays in the function that built it: nothing passes it
 * on or calls it, and every method called on it is one of `ownMethods`.
 * A router reader passes the methods its pack registers routes and mounts
 * with, since any other method, `listen` say, may serve the app.
 */
export function staysInItsFunction(
  uses: ValueUses,
  ownMethods: ReadonlySet<string>,
): boolean {
  return (
    !uses.passedOn &&
    uses.methodsCalled.every((method) => ownMethods.has(method))
  );
}
