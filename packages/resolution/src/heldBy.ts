/**
 * Where a value goes once it is built, followed through the project's
 * own code: the names it is written to, the modules that import it, the
 * parameters of the project functions it is passed to, and the calls to
 * a project function that returns it. The rules say which call each
 * read of it goes to, so a caller can tell a call into a library from a
 * call into the project.
 *
 * A served-beside reader asks this of an app its pack builds, to find
 * each place the app meets code suss does not read: a method the pack
 * does not list, a library call it is passed to, or an object it is
 * stored on. DESIGN.md, under "Where an app goes", lists the relations.
 */

import { lit, rule, variable as v } from "@suss/datalog";

import { askResolution, resolutionProgram } from "./program.js";

import type { Database, OnDemandRules, Rule, Term } from "@suss/datalog";

/** What a caller asks through, `askResolution(db, keys, HOLDERS_QUESTION)`, to learn where the value built at each key goes. */
export const HOLDERS_QUESTION = "wantedHolders";

const x = v("x");
const y = v("y");
const z = v("z");
const c = v("c");
const n = v("n");
const r = v("r");

/** Each way a name is written with a value. */
const NAME_WRITES = ["binds", "endsHolding", "mayHold"];

/**
 * `heldBy(x, y)`: the value built at x is held at y. The module's own
 * namespace-import constant comes in from the caller, since the rules
 * are built while that module is still loading.
 */
export function heldByRules(namespaceImport: Term): Rule[] {
  return [
    rule("heldBy", [x, x], [lit(HOLDERS_QUESTION, x)], "built"),
    ...NAME_WRITES.map((relation) =>
      rule(
        "heldBy",
        [x, y],
        [lit("heldBy", x, z), lit(relation, y, z)],
        "written to a name",
      ),
    ),
    rule(
      "heldBy",
      [x, y],
      [
        lit("heldBy", x, z),
        lit("moduleExport", v("m"), v("e"), z),
        lit("imports", y, v("m"), v("e")),
      ],
      "imported",
    ),
    rule(
      "heldBy",
      [x, y],
      [
        lit("heldBy", x, z),
        lit("moduleExport", v("m"), v("e"), z),
        lit("imports", v("ns"), v("m"), namespaceImport),
        lit("readsProperty", y, v("ns"), v("e")),
      ],
      "read off a module",
    ),
    rule(
      "heldBy",
      [x, y],
      [
        lit("heldBy", x, z),
        lit("callArg", r, v("k"), z),
        lit("callsFunction", r, v("f")),
        lit("paramOf", v("f"), v("k"), y),
      ],
      "a parameter",
    ),
    rule(
      "heldBy",
      [x, y],
      [
        lit("heldBy", x, z),
        lit("callKeywordArg", r, v("k"), z),
        lit("callsFunction", r, v("f")),
        lit("paramNamed", v("f"), v("k"), y),
      ],
      "a parameter by keyword",
    ),
    rule(
      "heldBy",
      [x, y],
      [
        lit("heldBy", x, z),
        lit("returnsValue", v("f"), z),
        lit("callsFunction", y, v("f")),
      ],
      "returned",
    ),
  ];
}

/** The two ways a call is passed a value. */
const ARGUMENTS = ["callArg", "callKeywordArg"];

/**
 * What `wantedHolders(x)` derives. Each answer starts from the question,
 * so a row cleared with it comes back when the question is asked again.
 */
export const HELD_BY_QUESTIONS: readonly Rule[] = [
  rule(
    "wantedHeldCall",
    [x, c, n],
    [
      lit(HOLDERS_QUESTION, x),
      lit("heldBy", x, z),
      lit("readsProperty", r, z, n),
      lit("call", c, r),
    ],
  ),
  ...ARGUMENTS.map((relation) =>
    rule(
      "wantedHeldArgument",
      [x, c],
      [
        lit(HOLDERS_QUESTION, x),
        lit("heldBy", x, z),
        lit(relation, c, v("k"), z),
      ],
    ),
  ),
  ...[
    ["callArg", "paramOf"],
    ["callKeywordArg", "paramNamed"],
  ].map(([passed, parameter]) =>
    rule(
      "wantedHeldInto",
      [x, c],
      [
        lit(HOLDERS_QUESTION, x),
        lit("heldBy", x, z),
        lit(passed ?? "", c, v("k"), z),
        lit("callsFunction", c, v("f")),
        lit(parameter ?? "", v("f"), v("k"), y),
      ],
    ),
  ),
  ...[
    lit("holdsProperty", v("o"), v("k"), z),
    lit("storesProperty", v("o"), v("k"), z, v("s")),
    lit("holdsUnderKey", v("o"), z),
  ].map((stored) =>
    rule(
      "wantedHeldStored",
      [x, v("o")],
      [lit(HOLDERS_QUESTION, x), lit("heldBy", x, z), stored],
    ),
  ),
  rule(
    "wantedHeldPartCall",
    [x, c, n],
    [
      lit(HOLDERS_QUESTION, x),
      lit("heldBy", x, z),
      lit("readsProperty", r, z, n),
      lit("readsProperty", v("m"), r, v("k")),
      lit("call", c, v("m")),
    ],
  ),
  ...ARGUMENTS.map((relation) =>
    rule(
      "wantedHeldPartArgument",
      [x, c, r, n],
      [
        lit(HOLDERS_QUESTION, x),
        lit("heldBy", x, z),
        lit("readsProperty", r, z, n),
        lit(relation, c, v("k"), r),
      ],
    ),
  ),
  rule(
    "wantedHeldPartPassed",
    [x, r, n],
    [
      lit(HOLDERS_QUESTION, x),
      lit("heldBy", x, z),
      lit("readsProperty", r, z, n),
      lit("passedOn", r),
    ],
  ),
];

/** Where one value goes, as the rules found it. */
export interface HeldUses {
  /** Each method called on it, by the call's key. */
  calls: readonly { call: string; method: string }[];
  /** Each call it is passed to, by position or keyword. */
  arguments: readonly string[];
  /** The calls among `arguments` that go to a project function whose parameter takes it. */
  into: ReadonlySet<string>;
  /** Each object it is held by or stored on, or stored under a key of. */
  stored: readonly string[];
  /** Each method called on one of its members, `app.router.add_route(...)`, by the call and the member. */
  partCalls: readonly { call: string; member: string }[];
  /** Each call one of its members is passed to, `wrap(app.wsgi_app)`, by the call, the member's read and the member. */
  partArguments: readonly { call: string; read: string; member: string }[];
  /** Each read of one of its members that is passed on in any way, the arguments above included. */
  partsPassed: readonly { read: string; member: string }[];
}

/**
 * Where the value built at each key goes. One question for the batch,
 * so the rules are evaluated once.
 */
export function heldUsesOf(
  db: Database,
  keys: readonly string[],
  program: OnDemandRules = resolutionProgram(),
): Map<string, HeldUses> {
  if (keys.length > 0) {
    askResolution(db, keys, HOLDERS_QUESTION, program);
  }
  return new Map(keys.map((key) => [key, readHeldUses(db, key)]));
}

/** What the rules derived for one key, read after the question was asked. */
export function readHeldUses(db: Database, key: string): HeldUses {
  const rows = (relation: string): string[][] =>
    db.lookup(relation, 0, key).map((row) => row.map(String));
  return {
    calls: rows("wantedHeldCall").map(([, call = "", method = ""]) => ({
      call,
      method,
    })),
    arguments: unique(rows("wantedHeldArgument").map(([, call = ""]) => call)),
    into: new Set(rows("wantedHeldInto").map(([, call = ""]) => call)),
    stored: unique(rows("wantedHeldStored").map(([, object = ""]) => object)),
    partCalls: rows("wantedHeldPartCall").map(([, call = "", member = ""]) => ({
      call,
      member,
    })),
    partArguments: rows("wantedHeldPartArgument").map(
      ([, call = "", read = "", member = ""]) => ({ call, read, member }),
    ),
    partsPassed: rows("wantedHeldPartPassed").map(
      ([, read = "", member = ""]) => ({ read, member }),
    ),
  };
}

function unique(keys: readonly string[]): string[] {
  return [...new Set(keys)];
}
