// The callee question over facts written by hand, so what is under test
// is the classification and not any one language's reading of source.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { calleeOutcomeOf, calleeOutcomes } from "./callee.js";

import type { CalleeOutcome } from "./callee.js";

function outcomeOf(
  facts: Array<[string, ...string[]]>,
  callee: string,
): CalleeOutcome {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  return calleeOutcomeOf(db, callee);
}

describe("calleeOutcomeOf", () => {
  it("comes back with the one function a name reaches", () => {
    expect(
      outcomeOf(
        [
          ["func", "load"],
          ["binds", "run", "load"],
        ],
        "run",
      ),
    ).toEqual({ kind: "function", key: "load" });
  });

  it("comes back with the class a construction reaches", () => {
    expect(
      outcomeOf(
        [
          ["objectValue", "Service"],
          ["binds", "kept", "make"],
          ["call", "make", "Service"],
        ],
        "kept",
      ),
    ).toEqual({ kind: "object", key: "Service" });
  });

  it("refuses a name two modules both export under it", () => {
    const outcome = outcomeOf(
      [
        ["func", "first"],
        ["func", "second"],
        ["imports", "load", "one.py", "load"],
        ["imports", "load", "two.py", "load"],
        ["exportsAs", "one.py", "load", "first"],
        ["exportsAs", "two.py", "load", "second"],
      ],
      "load",
    );
    expect(outcome.kind).toBe("severalSources");
  });

  it("says a parameter is the caller's, and whose parameter it is", () => {
    expect(
      outcomeOf(
        [["paramNamed", "apply", "handler", "apply#handler"]],
        "apply#handler",
      ),
    ).toEqual({ kind: "callerSupplied", key: "apply#handler" });
  });

  it("keeps a parameter the caller's rather than following one caller's argument", () => {
    expect(
      outcomeOf(
        [
          ["func", "apply"],
          ["func", "build"],
          ["paramOf", "apply", "0", "apply#handler"],
          ["call", "r", "apply"],
          ["callArg", "r", "0", "build"],
        ],
        "apply#handler",
      ).kind,
    ).toBe("callerSupplied");
  });

  it("counts the caller's value alongside a write that replaces it", () => {
    const outcome = outcomeOf(
      [
        ["objectValue", "Entity"],
        ["paramNamed", "replace", "thing", "replace#thing"],
        ["mayHold", "replace#thing", "made"],
        ["call", "made", "Entity"],
      ],
      "replace#thing",
    );
    expect(outcome.kind).toBe("severalSources");
  });

  it("sets a source that leads back to the name aside", () => {
    const outcome = outcomeOf(
      [
        ["paramNamed", "narrow", "query", "narrow#query"],
        ["mayHold", "narrow#query", "tmp"],
        ["binds", "tmp", "limited"],
        ["call", "limited", "limit"],
        ["readsProperty", "limit", "narrow#query", "limit"],
      ],
      "narrow#query",
    );
    expect(outcome.kind).toBe("callerSupplied");
  });

  it("refuses a name whose writes disagree", () => {
    const outcome = outcomeOf(
      [
        ["objectValue", "Entity"],
        ["mayHold", "thing", "made"],
        ["mayHold", "thing", "text"],
        ["call", "made", "Entity"],
        ["writtenValue", "text"],
      ],
      "thing",
    );
    expect(outcome.kind).toBe("severalSources");
  });

  it("puts a name from a module this run never read outside the run", () => {
    expect(
      outcomeOf([["imports", "getLogger", "logging", "getLogger"]], "getLogger")
        .kind,
    ).toBe("outsideRun");
  });

  it("puts a method on a value written out where it stands outside the run", () => {
    expect(
      outcomeOf(
        [
          ["writtenValue", "text"],
          ["binds", "greeting", "text"],
          ["readsProperty", "greeting.upper", "greeting", "upper"],
        ],
        "greeting.upper",
      ).kind,
    ).toBe("outsideRun");
  });

  it("leaves a method on what a project function returned unsettled", () => {
    expect(
      outcomeOf(
        [
          ["func", "make"],
          ["binds", "thing", "built"],
          ["call", "built", "make"],
          ["readsProperty", "thing.start", "thing", "start"],
        ],
        "thing.start",
      ).kind,
    ).toBe("unsettled");
  });

  it("leaves a name a write states no value for unsettled", () => {
    expect(outcomeOf([["writesUnstated", "step"]], "step").kind).toBe(
      "unsettled",
    );
  });

  it("says a member of a settled value nothing declares is undeclared", () => {
    expect(
      outcomeOf(
        [
          ["func", "load"],
          ["binds", "run", "load"],
          ["readsProperty", "run.cache_clear", "run", "cache_clear"],
        ],
        "run.cache_clear",
      ).kind,
    ).toBe("undeclared");
  });

  it("says nothing about a callee nothing in the run mentions", () => {
    expect(outcomeOf([], "nowhere").kind).toBe("undeclared");
  });

  it("settles a batch of callees in one pass", () => {
    const db = new Database();
    db.add("func", ["load"]);
    db.add("binds", ["run", "load"]);
    const outcomes = calleeOutcomes(db, ["run", "nowhere"]);
    expect(outcomes.get("run")).toEqual({ kind: "function", key: "load" });
    expect(outcomes.get("nowhere")?.kind).toBe("undeclared");
  });
});
