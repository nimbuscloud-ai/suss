// The exit-code question over facts written by hand, so what is under
// test is the walk from a value to the functions it returns through.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { exitCodeFunctions } from "./exitCode.js";

function databaseOf(facts: Array<[string, ...string[]]>): Database {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  return db;
}

/** `runCli` returns what `dispatch(args)` returns. */
const COMMAND: Array<[string, ...string[]]> = [
  ["func", "runCli"],
  ["func", "dispatch"],
  ["binds", "runCliRef", "runCli"],
  ["call", "runCliCall", "runCliRef"],
  ["returnsValue", "runCli", "dispatchCall"],
  ["binds", "dispatchRef", "dispatch"],
  ["call", "dispatchCall", "dispatchRef"],
];

describe("exitCodeFunctions", () => {
  it("lists the function a call handed to exit invokes, and every one it returns through", () => {
    const db = databaseOf(COMMAND);
    expect([...exitCodeFunctions(db, ["runCliCall"])].sort()).toEqual([
      "dispatch",
      "runCli",
    ]);
  });

  it("follows a .then callback's parameter back to the call it was chained on", () => {
    const db = databaseOf([
      ...COMMAND,
      ["readsProperty", "thenRef", "runCliCall", "then"],
      ["call", "thenCall", "thenRef"],
      ["func", "callback"],
      ["callArg", "thenCall", "0", "callback"],
      ["paramOf", "callback", "0", "code"],
      ["binds", "codeRef", "code"],
    ]);
    expect([...exitCodeFunctions(db, ["codeRef"])].sort()).toEqual([
      "dispatch",
      "runCli",
    ]);
  });

  it("asks nothing when no value ends up as the code", () => {
    expect(exitCodeFunctions(databaseOf(COMMAND), [])).toEqual(new Set());
  });
});
