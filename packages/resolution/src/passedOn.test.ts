// Where a value goes, over facts written by hand, so what is under test
// is which facts count as handing the value on.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { readUses, staysInItsFunction, USES_QUESTION } from "./passedOn.js";
import { askResolution } from "./program.js";

function usesAfter(facts: Array<[string, ...string[]]>, key = "app") {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  askResolution(db, [key], USES_QUESTION);
  return readUses(db, key);
}

/** `app.use("/t", router)`, the mount itself. */
const MOUNT: Array<[string, ...string[]]> = [
  ["readsProperty", "app.use", "app", "use"],
  ["call", "mountCall", "app.use"],
  ["callArg", "mountCall", "1", "router"],
];

describe("where a value goes", () => {
  it("stays put when the only read calls a method on it", () => {
    expect(usesAfter(MOUNT)).toEqual({
      passedOn: false,
      methodsCalled: ["use"],
    });
  });

  it.each<[string, Array<[string, ...string[]]>]>([
    ["returned", [["returnsValue", "build", "app"]]],
    ["yielded", [["yieldsValue", "build", "app"]]],
    ["an argument", [["callArg", "serve", "0", "app"]]],
    ["a keyword argument", [["callKeywordArg", "serve", "app", "app"]]],
    ["bound to another name", [["binds", "served", "app"]]],
    ["another name's last write", [["endsHolding", "served", "app"]]],
    ["one of another name's writes", [["mayHold", "served", "app"]]],
    ["held by an object", [["holdsProperty", "holder", "app", "app"]]],
    [
      "stored through a parameter",
      [["storesProperty", "holder", "app", "app", "unplaced"]],
    ],
    ["stored under a key", [["holdsUnderKey", "apps", "app"]]],
    ["used as a key", [["readsKeyed", "entry", "apps", "app"]]],
    ["entered", [["entersValue", "app"]]],
    ["entered under a name", [["entersAs", "opened", "app"]]],
    ["a parameter default", [["paramDefault", "served", "app"]]],
    ["a fallback branch", [["fallbackBranch", "either", "app"]]],
    ["a conditional branch", [["conditionalBranch", "either", "app"]]],
    ["called", [["call", "run", "app"]]],
  ])("is passed on when %s", (_, facts) => {
    expect(usesAfter([...MOUNT, ...facts]).passedOn).toBe(true);
  });

  it("is passed on when a property read off it is passed on", () => {
    const uses = usesAfter([
      ...MOUNT,
      ["readsProperty", "app.fetch", "app", "fetch"],
      ["holdsProperty", "options", "fetch", "app.fetch"],
    ]);
    expect(uses.passedOn).toBe(true);
  });

  it("is passed on when an entry read off it is passed on", () => {
    const uses = usesAfter([
      ...MOUNT,
      ["readsKeyed", "app[k]", "app", "k"],
      ["returnsValue", "build", "app[k]"],
    ]);
    expect(uses.passedOn).toBe(true);
  });

  it("stays put when a property read off it goes nowhere", () => {
    const uses = usesAfter([
      ...MOUNT,
      ["readsProperty", "app.title", "app", "title"],
    ]);
    expect(uses.passedOn).toBe(false);
  });

  it("lists each method called on it once", () => {
    const uses = usesAfter([
      ...MOUNT,
      ["readsProperty", "app.listen", "app", "listen"],
      ["call", "listenCall", "app.listen"],
      ["readsProperty", "app.use2", "app", "use"],
      ["call", "mountCall2", "app.use2"],
    ]);
    expect([...uses.methodsCalled].sort()).toEqual(["listen", "use"]);
  });
});

describe("staysInItsFunction", () => {
  const own = new Set(["use", "get"]);

  it("holds when nothing passes the value on and only its own methods run", () => {
    expect(
      staysInItsFunction({ passedOn: false, methodsCalled: ["use"] }, own),
    ).toBe(true);
  });

  it("fails when another method may serve it", () => {
    expect(
      staysInItsFunction(
        { passedOn: false, methodsCalled: ["use", "listen"] },
        own,
      ),
    ).toBe(false);
  });

  it("fails when a read passes it on", () => {
    expect(staysInItsFunction({ passedOn: true, methodsCalled: [] }, own)).toBe(
      false,
    );
  });
});
