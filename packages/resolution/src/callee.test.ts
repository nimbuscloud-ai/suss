// The callee question over facts written by hand, so what is under test
// is the classification and not any one language's reading of source.

import { describe, expect, it } from "vitest";

import { Database, lit, rule, variable as v } from "@suss/datalog";

import { calleeOutcomeOf, calleeOutcomes, couldBeSettled } from "./callee.js";
import { RESOLUTION_QUESTIONS, RESOLUTION_RULES, VALUE_STEP } from "./index.js";
import {
  ASKING_RELATIONS,
  askResolution,
  queryFacts,
  resolutionProgram,
} from "./program.js";

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

  it("settles a step only a language's own rules state", () => {
    const aliased = (): Database => {
      const db = new Database();
      db.add("func", ["load"]);
      db.add("rbAliases", ["run", "load"]);
      return db;
    };
    const language = [
      rule(
        "stepsTo",
        [v("x"), v("y"), VALUE_STEP],
        [lit("rbAliases", v("x"), v("y"))],
      ),
    ];
    expect(calleeOutcomeOf(aliased(), "run").kind).toBe("undeclared");
    expect(
      calleeOutcomeOf(aliased(), "run", resolutionProgram(language)),
    ).toEqual({ kind: "function", key: "load" });
  });
});

describe("couldBeSettled", () => {
  const over = (facts: Array<[string, ...string[]]>, key: string): boolean => {
    const db = new Database();
    for (const [name, ...tuple] of facts) {
      db.add(name, tuple);
    }
    return couldBeSettled(db, key);
  };

  it("says yes to a name something wrote to", () => {
    expect(over([["binds", "run", "load"]], "run")).toBe(true);
  });

  it("says yes to a value the run states outright", () => {
    expect(over([["func", "load"]], "load")).toBe(true);
    expect(over([["objectValue", "Service"]], "Service")).toBe(true);
  });

  it("says yes to a read off another value, and to what a call gave back", () => {
    expect(over([["readsProperty", "host", "config", "host"]], "host")).toBe(
      true,
    );
    expect(over([["call", "made", "build"]], "made")).toBe(true);
  });

  it("says no to a key this run says nothing about", () => {
    expect(over([["binds", "other", "load"]], "run")).toBe(false);
  });

  it("agrees with the outcome, which is undeclared for such a key", () => {
    expect(outcomeOf([["binds", "other", "load"]], "run").kind).toBe(
      "undeclared",
    );
  });
});

describe("askResolution", () => {
  const asked = (): Database => {
    const db = new Database();
    db.add("func", ["load"]);
    db.add("binds", ["run", "load"]);
    db.add("binds", ["again", "run"]);
    askResolution(db, ["run"]);
    return db;
  };

  it("leaves the question and everything derived under it behind", () => {
    const db = asked();
    for (const relation of queryFacts(resolutionProgram())) {
      expect([relation, db.facts(relation).length]).toEqual([relation, 0]);
    }
    expect(db.facts("wantedComesTo")).toEqual([["run", "load"]]);
  });

  it("keeps the answer to a question asked twice, and settles a new one", () => {
    const db = asked();
    askResolution(db, ["run"]);
    expect(calleeOutcomeOf(db, "run")).toEqual({
      kind: "function",
      key: "load",
    });
    expect(calleeOutcomeOf(db, "again")).toEqual({
      kind: "function",
      key: "load",
    });
    expect(db.facts("wanted")).toEqual([]);
  });

  it("asks with the relation the caller names", () => {
    const db = new Database();
    db.add("func", ["load"]);
    db.add("imports", ["run", "lib", "load"]);
    askResolution(db, ["run"], "wantedOrigin");
    expect(db.facts("wantedComesFrom")).toEqual([["run", "lib", "load"]]);
  });
});

describe("ASKING_RELATIONS", () => {
  it("lists every fact a question waits for a caller to add", () => {
    const derived = new Set(
      [...RESOLUTION_RULES, ...RESOLUTION_QUESTIONS].map(
        (one) => one.head.relation,
      ),
    );
    const seeds = new Set(
      RESOLUTION_QUESTIONS.flatMap((one) => one.body.map((l) => l.relation))
        .filter((relation) => relation.startsWith("wanted"))
        .filter((relation) => !derived.has(relation)),
    );
    expect([...seeds].sort()).toEqual([...ASKING_RELATIONS].sort());
  });
});
