// What a call may run when it takes its function from a table, over facts
// written by hand, so what is under test is the rules and not any one
// language's reading of source.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { dispatchOutcomes } from "./dispatch.js";
import { exitCodeFunctions } from "./exitCode.js";

import type { DispatchOutcome } from "./dispatch.js";

type Fact = [string, ...string[]];

function load(facts: readonly Fact[]): Database {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  return db;
}

function outcomeOf(
  facts: readonly Fact[],
  call: string,
): DispatchOutcome | undefined {
  return dispatchOutcomes(load(facts), [call]).get(call);
}

function sorted(values: Iterable<string> | undefined): string[] {
  return [...(values ?? [])].sort();
}

/** `TABLE = { init: runInit, check: runCheck }`, the table every case reads. */
const TABLE: readonly Fact[] = [
  ["func", "runInit"],
  ["func", "runCheck"],
  ["func", "runAsk"],
  ["objectValue", "table"],
  ["holdsProperty", "table", "init", "runInit"],
  ["holdsProperty", "table", "check", "runCheck"],
  ["holdsProperty", "table", "ask", "runAsk"],
  ["binds", "TABLE", "table"],
];

describe("dispatchOutcomes", () => {
  it("says a key nothing narrows may run every function in the table", () => {
    const outcome = outcomeOf(
      [
        ...TABLE,
        ["choosesEntry", "TABLE[k]", "TABLE"],
        ["call", "TABLE[k](args)", "TABLE[k]"],
      ],
      "TABLE[k](args)",
    );
    expect(sorted(outcome?.functions)).toEqual([
      "runAsk",
      "runCheck",
      "runInit",
    ]);
    expect(outcome?.certain).toBe(false);
  });

  it("follows a name the read was given before the call", () => {
    const outcome = outcomeOf(
      [
        ...TABLE,
        ["choosesEntry", "TABLE[k]", "TABLE"],
        ["binds", "run", "TABLE[k]"],
        ["call", "run(rest)", "run"],
      ],
      "run(rest)",
    );
    expect(outcome?.functions).toHaveLength(3);
  });

  it("keeps a key narrowed to some names to the entries under them", () => {
    const outcome = outcomeOf(
      [
        ...TABLE,
        ["choosesNamedEntry", "TABLE[k]", "TABLE", "init"],
        ["choosesNamedEntry", "TABLE[k]", "TABLE", "check"],
        ["call", "TABLE[k]()", "TABLE[k]"],
      ],
      "TABLE[k]()",
    );
    expect(sorted(outcome?.functions)).toEqual(["runCheck", "runInit"]);
    expect(outcome?.certain).toBe(false);
  });

  it("says a key written out runs the one entry under it", () => {
    const outcome = outcomeOf(
      [
        ...TABLE,
        ["readsEntry", "TABLE['check']", "TABLE", "check"],
        ["call", "TABLE['check']()", "TABLE['check']"],
      ],
      "TABLE['check']()",
    );
    expect(outcome).toEqual({
      functions: ["runCheck"],
      certain: true,
      unresolved: 0,
      through: new Map(),
      containers: ["TABLE"],
    });
  });

  it("finds what a registry function stored under a computed key", () => {
    const outcome = outcomeOf(
      [
        ["func", "onCreated"],
        ["func", "register"],
        ["objectValue", "registry"],
        ["binds", "REGISTRY", "registry"],
        ["paramOf", "register", "1", "register#handler"],
        ["holdsUnderKey", "REGISTRY", "register#handler"],
        ["binds", "register@call", "register"],
        ["call", "register('created', onCreated)", "register@call"],
        ["callArg", "register('created', onCreated)", "1", "onCreated"],
        ["choosesNamedEntry", "REGISTRY[k]", "REGISTRY", "created"],
        ["call", "REGISTRY[k]()", "REGISTRY[k]"],
      ],
      "REGISTRY[k]()",
    );
    expect(outcome?.functions).toEqual(["onCreated"]);
    // A computed key could be any name, so even a narrowed read is not sure.
    expect(outcome?.certain).toBe(false);
  });

  it("finds what a collection's method put in it", () => {
    const outcome = outcomeOf(
      [
        ["func", "onCreated"],
        ["collectionValue", "new Map()"],
        ["binds", "byName", "new Map()"],
        ["binds", "byName@set", "byName"],
        ["holdsUnderKey", "byName@set", "onCreated"],
        ["binds", "byName@get", "byName"],
        ["choosesEntry", "byName.get(k)", "byName@get"],
        ["binds", "handler", "byName.get(k)"],
        ["call", "handler()", "handler"],
      ],
      "handler()",
    );
    expect(outcome?.functions).toEqual(["onCreated"]);
  });

  it("reads a call that is its own entry read, as Ruby's send is", () => {
    const outcome = outcomeOf(
      [
        ["func", "created"],
        ["func", "deleted"],
        ["objectValue", "Events"],
        ["holdsProperty", "Events", "created", "created"],
        ["holdsProperty", "Events", "deleted", "deleted"],
        ["instanceOf", "self", "Events"],
        ["choosesEntry", "send(kind)", "self"],
        ["callsChosenEntry", "send(kind)"],
      ],
      "send(kind)",
    );
    expect(sorted(outcome?.functions)).toEqual(["created", "deleted"]);
  });

  it("keeps the members whose name starts and ends with what a partly written key writes", () => {
    const outcome = outcomeOf(
      [
        ["func", "complete_profile"],
        ["func", "complete_billing"],
        ["func", "reset"],
        ["objectValue", "Onboarding"],
        ["holdsProperty", "Onboarding", "complete_profile", "complete_profile"],
        ["holdsProperty", "Onboarding", "complete_billing", "complete_billing"],
        ["holdsProperty", "Onboarding", "reset", "reset"],
        ["instanceOf", "self", "Onboarding"],
        ["choosesEntryLike", "send(step)", "self", "complete_", ""],
        ["callsChosenEntry", "send(step)"],
      ],
      "send(step)",
    );
    expect(sorted(outcome?.functions)).toEqual([
      "complete_billing",
      "complete_profile",
    ]);
    expect(outcome?.certain).toBe(false);
  });

  it("counts an entry that comes to no function", () => {
    const outcome = outcomeOf(
      [
        ...TABLE,
        ["holdsProperty", "table", "lint", "imported"],
        ["imports", "imported", "linter", "lint"],
        ["choosesEntry", "TABLE[k]", "TABLE"],
        ["call", "TABLE[k]()", "TABLE[k]"],
      ],
      "TABLE[k]()",
    );
    expect(outcome?.unresolved).toBe(1);
    expect(outcome?.functions).toHaveLength(3);
  });

  it("lists what an entry written as a lambda calls", () => {
    const outcome = outcomeOf(
      [
        ["func", "lambda"],
        ["func", "onArchived"],
        ["objectValue", "table"],
        ["holdsProperty", "table", "archived", "lambda"],
        ["makesCall", "lambda", "onArchived(p)"],
        ["call", "onArchived(p)", "onArchived@ref"],
        ["binds", "onArchived@ref", "onArchived"],
        ["choosesEntry", "table[k]", "table"],
        ["call", "table[k](p)", "table[k]"],
      ],
      "table[k](p)",
    );
    expect(outcome?.through.get("lambda")).toEqual(["onArchived"]);
  });

  it("leaves out a call that takes no function from a table", () => {
    const db = load([
      ["func", "load"],
      ["binds", "load@ref", "load"],
      ["call", "load()", "load@ref"],
    ]);
    expect(dispatchOutcomes(db, ["load()"]).size).toBe(0);
  });
});

describe("exit codes through a table", () => {
  it("reaches the functions a dispatch table runs, and what they return", () => {
    const db = load([
      ...TABLE,
      ["func", "dispatch"],
      ["func", "askInteractive"],
      ["choosesEntry", "TABLE[k]", "TABLE"],
      ["binds", "run", "TABLE[k]"],
      ["call", "run(rest)", "run"],
      ["returnsValue", "dispatch", "run(rest)"],
      ["returnsValue", "runAsk", "askInteractive()"],
      ["binds", "askInteractive@ref", "askInteractive"],
      ["call", "askInteractive()", "askInteractive@ref"],
      ["binds", "dispatch@ref", "dispatch"],
      ["call", "dispatch(args)", "dispatch@ref"],
    ]);
    expect(sorted(exitCodeFunctions(db, ["dispatch(args)"]))).toEqual([
      "askInteractive",
      "dispatch",
      "runAsk",
      "runCheck",
      "runInit",
    ]);
  });
});
