// Where an app goes, over facts written by hand, so what is under test is
// which facts carry the app on and which calls the answer says it meets.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { heldUsesOf } from "./index.js";

type Facts = Array<[string, ...string[]]>;

function usesAfter(facts: Facts, key = "made") {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  const uses = heldUsesOf(db, [key]).get(key);
  expect(uses).toBeDefined();
  return uses as NonNullable<typeof uses>;
}

/** `app = FastAPI()` at the top of `main.py`. */
const BUILT: Facts = [["binds", "main#app", "made"]];

/** A project function `setup(server)`, called from `main.py` as `setup(...)`. */
const SETUP: Facts = [
  ["func", "setupFn"],
  ["binds", "main#setup", "setupFn"],
  ["paramOf", "setupFn", "0", "setupFn#server"],
  ["call", "setupCall", "main#setup"],
];

describe("where an app goes", () => {
  it("lists each method called on it, under any name it is written to", () => {
    const uses = usesAfter([
      ...BUILT,
      ["binds", "main#application", "main#app"],
      ["readsProperty", "frontendRead", "main#application", "frontend"],
      ["call", "frontendCall", "frontendRead"],
    ]);

    expect(uses.calls).toEqual([{ call: "frontendCall", method: "frontend" }]);
    expect(uses.arguments).toEqual([]);
  });

  it("lists a call it is passed to, by position or by keyword", () => {
    const uses = usesAfter([
      ...BUILT,
      ["callArg", "runCall", "0", "main#app"],
      ["callKeywordArg", "wrapCall", "app", "main#app"],
    ]);

    expect([...uses.arguments].sort()).toEqual(["runCall", "wrapCall"]);
    expect(uses.into.size).toBe(0);
  });

  it("follows it into a project function's parameter, and says that call goes into the project", () => {
    const uses = usesAfter([
      ...BUILT,
      ...SETUP,
      ["callArg", "setupCall", "0", "main#app"],
      ["readsProperty", "mountRead", "setupFn#server", "mount"],
      ["call", "mountCall", "mountRead"],
    ]);

    expect(uses.arguments).toEqual(["setupCall"]);
    expect([...uses.into]).toEqual(["setupCall"]);
    expect(uses.calls).toEqual([{ call: "mountCall", method: "mount" }]);
  });

  it("follows it into another module that imports it, by name or off the module", () => {
    const uses = usesAfter([
      ...BUILT,
      ["exportsAs", "main", "app", "main#app"],
      ["imports", "metrics#app", "main", "app"],
      ["callArg", "exposeCall", "0", "metrics#app"],
      ["imports", "tasks#main", "main", "*"],
      ["readsProperty", "appRead", "tasks#main", "app"],
      ["callArg", "instrumentCall", "0", "appRead"],
    ]);

    expect([...uses.arguments].sort()).toEqual([
      "exposeCall",
      "instrumentCall",
    ]);
  });

  it("follows it out of a project function that returns it, to the call's result", () => {
    const uses = usesAfter([
      ["binds", "factory#app", "made"],
      ["func", "factory"],
      ["returnsValue", "factory", "factory#app"],
      ["binds", "main#create_app", "factory"],
      ["call", "createCall", "main#create_app"],
      ["binds", "main#app", "createCall"],
      ["readsProperty", "frontendRead", "main#app", "frontend"],
      ["call", "frontendCall", "frontendRead"],
    ]);

    expect(uses.calls).toEqual([{ call: "frontendCall", method: "frontend" }]);
  });

  it("lists a member read off it that has a method called or is passed on", () => {
    const uses = usesAfter([
      ...BUILT,
      ["readsProperty", "routerRead", "main#app", "router"],
      ["readsProperty", "addRead", "routerRead", "add_route"],
      ["call", "addCall", "addRead"],
      ["readsProperty", "wsgiRead", "main#app", "wsgi_app"],
      ["callArg", "fixCall", "0", "wsgiRead"],
    ]);

    expect(uses.partCalls).toEqual([{ call: "addCall", member: "router" }]);
    expect(uses.partArguments).toEqual([
      { call: "fixCall", read: "wsgiRead", member: "wsgi_app" },
    ]);
    expect(uses.partsPassed).toEqual([
      { read: "wsgiRead", member: "wsgi_app" },
    ]);
  });

  it("lists an object it is stored on", () => {
    const uses = usesAfter([
      ...BUILT,
      ["storesProperty", "selfRead", "app", "main#app", "unplaced"],
    ]);

    expect(uses.stored).toEqual(["selfRead"]);
  });
});
