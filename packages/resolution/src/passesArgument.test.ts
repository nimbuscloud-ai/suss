// What `passesArgument` costs when a walk asks it from the argument's side,
// the way a walk back from a value to the parameters it reaches does.

import { describe, expect, it } from "vitest";

import {
  Database,
  deriveOnDemand,
  evaluate,
  lit,
  rowBudget,
  rule,
  variable,
} from "@suss/datalog";

import { RESOLUTION_RULES } from "./index.js";

const v = variable;

// Asks where one argument goes, with the argument bound and the call free.
const PROGRAM = deriveOnDemand(
  [
    ...RESOLUTION_RULES,
    rule(
      "argumentGoesTo",
      [v("r"), v("p")],
      [
        lit("argumentAsked", v("a")),
        lit("passesArgument", v("r"), v("p"), v("a")),
      ],
    ),
  ],
  ["argumentGoesTo"],
);

// `send(payload)` calls `function send(body)`, beside `others` functions
// that each take a first parameter of their own and are never called.
function sendDb(others: number): Database {
  const facts: Array<[string, ...string[]]> = [
    ["func", "send"],
    ["paramOf", "send", "0", "body"],
    ["binds", "sendRef", "send"],
    ["call", "sendCall", "sendRef"],
    ["callArg", "sendCall", "0", "payload"],
    ["argumentAsked", "payload"],
  ];
  for (let i = 0; i < others; i++) {
    facts.push(["func", `other${i}`], ["paramOf", `other${i}`, "0", `p${i}`]);
  }
  const db = new Database();
  for (const [relation, ...tuple] of facts) {
    db.add(relation, tuple);
  }
  return db;
}

function rowsToAsk(db: Database): number {
  const budget = rowBudget(Number.MAX_SAFE_INTEGER);
  evaluate(db, PROGRAM.rules, undefined, budget);
  return budget.examined;
}

describe("an argument asked where it goes", () => {
  it("arrives at the parameter of the function its call runs", () => {
    const db = sendDb(0);
    rowsToAsk(db);

    expect(db.facts("argumentGoesTo")).toEqual([["sendCall", "body"]]);
  });

  it("reads the same rows however many other functions take a parameter there", () => {
    expect(rowsToAsk(sendDb(200))).toBe(rowsToAsk(sendDb(10)));
  });
});
