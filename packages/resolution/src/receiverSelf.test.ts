// Which values in a method come from its own receiver, which variants of
// a method a walk keeps, and how a class's members are looked up, over
// facts written by hand.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { memberOf } from "./members.js";
import { askResolution, resolutionProgram } from "./program.js";
import {
  keptVariants,
  plainKeyOf,
  selfFormOf,
  selfResultOf,
  variantKey,
} from "./receiverSelf.js";

type Fact = [string, ...string[]];

function load(facts: readonly Fact[]): Database {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  return db;
}

function asked(facts: readonly Fact[], keys: readonly string[]): Database {
  const db = load(facts);
  askResolution(db, keys, "wanted", resolutionProgram());
  return db;
}

/**
 * `class Base` with a classmethod `call(cls)` that returns
 * `cls(**kw).run()`, and a classmethod `build(cls)` that returns `cls()`.
 * `Sub(Base)` writes its own `run`.
 */
const SERVICES: readonly Fact[] = [
  ["objectValue", "Base"],
  ["objectValue", "Sub"],
  ["binds", "BaseName", "Base"],
  ["binds", "SubName", "Sub"],
  ["extends", "Sub", "BaseName"],
  ["func", "call"],
  ["func", "build"],
  ["func", "run"],
  ["func", "subRun"],
  ["holdsProperty", "Base", "call", "call"],
  ["holdsProperty", "Base", "build", "build"],
  ["holdsProperty", "Base", "run", "run"],
  ["holdsProperty", "Sub", "run", "subRun"],
  ["binds", "call#cls", "Base"],
  ["selfReceiver", "call", "call#cls", "class"],
  ["call", "made", "call#cls"],
  ["binds", "made2", "made"],
  ["binds", "build#cls", "Base"],
  ["selfReceiver", "build", "build#cls", "class"],
  ["call", "built", "build#cls"],
  ["returnsValue", "build", "built"],
];

describe("selfBehind", () => {
  it("says the receiver, a name for it and a call of it come from the receiver", () => {
    const db = asked(SERVICES, ["call#cls", "made", "made2"]);

    expect(selfFormOf(db, "call#cls", "call#cls")).toBe("class");
    expect(selfFormOf(db, "made", "call#cls")).toBe("instance");
    expect(selfFormOf(db, "made2", "call#cls")).toBe("instance");
  });

  it("says nothing about a value that never meets the receiver", () => {
    const db = asked([...SERVICES, ["call", "direct", "BaseName"]], ["direct"]);

    expect(selfFormOf(db, "direct", "call#cls")).toBeNull();
  });

  it("does not follow the receiver into another method's parameter", () => {
    const db = asked(
      [
        ...SERVICES,
        ["func", "helper"],
        ["paramOf", "helper", "0", "helper#k"],
        ["call", "handOff", "helper"],
        ["callArg", "handOff", "0", "call#cls"],
      ],
      ["helper#k"],
    );

    expect(selfFormOf(db, "helper#k", "call#cls")).toBeNull();
  });
});

describe("selfResult", () => {
  it("says a call to a method that returns one of its receiver gives back one of what it was sent to", () => {
    const db = asked(
      [
        ...SERVICES,
        ["readsProperty", "SubName.build", "SubName", "build"],
        ["call", "SubName.build()", "SubName.build"],
        ["binds", "service", "SubName.build()"],
      ],
      ["SubName.build()", "service"],
    );

    expect(selfResultOf(db, "SubName.build()")).toEqual({
      receiver: "SubName",
      form: "instance",
    });
    expect(selfResultOf(db, "service")).toEqual({
      receiver: "SubName",
      form: "instance",
    });
  });
});

describe("memberOf", () => {
  it("finds the subclass's own member over the one it inherits", () => {
    const db = load(SERVICES);

    expect(memberOf(db, "Sub", "run", resolutionProgram())).toBe("subRun");
    expect(memberOf(db, "Sub", "build", resolutionProgram())).toBe("build");
    expect(memberOf(db, "Base", "run", resolutionProgram())).toBe("run");
    expect(memberOf(db, "Sub", "missing", resolutionProgram())).toBeNull();
  });
});

describe("keptVariants", () => {
  it("keeps a variant that goes somewhere else, and each variant that calls one", () => {
    const kept = keptVariants([
      { key: "call@Sub", differs: false, calls: ["runWithLog@Sub", "log"] },
      { key: "runWithLog@Sub", differs: true, calls: ["subRun"] },
      { key: "log@Sub", differs: false, calls: [] },
      { key: "loop@Sub", differs: false, calls: ["loop@Sub"] },
    ]);

    expect([...kept].sort()).toEqual(["call@Sub", "runWithLog@Sub"]);
  });
});

describe("variantKey", () => {
  it("keeps the method's own key in front, so the file still comes first", () => {
    const key = variantKey("/app/base.rb:10-40", {
      name: "Invoices::CreateService",
      file: "/app/invoices/create_service.rb",
    });

    expect(key.startsWith("/app/base.rb:10-40")).toBe(true);
    expect(key.slice(0, key.lastIndexOf(":"))).toBe("/app/base.rb");
    expect(plainKeyOf(key)).toBe("/app/base.rb:10-40");
    expect(plainKeyOf("/app/base.rb:10-40")).toBe("/app/base.rb:10-40");
  });
});
