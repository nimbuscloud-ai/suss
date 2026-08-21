import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { checkFactContract, FACT_CONTRACT_CASES } from "./contract.js";

/** Facts an adapter that satisfies every case would produce. */
function conformingFacts(): Database {
  const db = new Database();
  db.add("paramOf", ["fn:a", "0", "fn:a#loader"]);
  db.add("paramOf", ["fn:b", "0", "fn:b#loader"]);
  db.add("returnsValue", ["fn:a", "fn:a#loader"]);
  db.add("call", ["call:1", "f#build"]);
  db.add("writtenValue", ["call:1"]);
  db.add("objectValue", ["list:1"]);
  db.add("holdsProperty", ["list:1", "0", "f#first"]);
  db.add("holdsProperty", ["list:1", "1", "f#second"]);
  db.add("func", ["fn:a"]);
  db.add("objectValue", ["class:1"]);
  db.add("holdsProperty", ["class:1", "load", "fn:a"]);
  db.add("paramOf", ["class:1", "0", "class:1#source"]);
  db.add("callArg", ["call:1", "0", "f#source"]);
  db.add("exportsAs", ["f.py", "build", "fn:a"]);
  db.add("imports", ["f.py#renamed", "source.py", "value"]);
  db.add("fallbackBranch", ["or:1", "f#cached"]);
  db.add("fallbackBranch", ["or:1", "call:1"]);
  return db;
}

// Two files, because a case about a value leaving its file needs somewhere
// for it to have come from. The fake adapter below ignores the source anyway.
const everyCase = Object.fromEntries(
  FACT_CONTRACT_CASES.map((c) => [c.name, { "f.py": "", "source.py": "" }]),
);

describe("the fact contract", () => {
  it("passes an adapter that keys everything the way the rules expect", async () => {
    expect(await checkFactContract(everyCase, conformingFacts)).toEqual([]);
  });

  it("catches two parameters sharing a key", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("paramOf", [["fn:b", "0", "fn:b#loader"]]);
      db.add("paramOf", ["fn:b", "0", "fn:a#loader"]);
      return db;
    });
    expect(failures.map((f) => f.case)).toContain(
      "two functions, one parameter name",
    );
  });

  it("catches a class that is not an object value", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("objectValue", [["class:1"], ["list:1"]]);
      return db;
    });
    expect(failures.map((f) => f.problem).join(" ")).toContain(
      "a class is not an object value",
    );
  });

  it("catches a class containing none of its methods", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("holdsProperty", [["class:1", "load", "fn:a"]]);
      return db;
    });
    expect(failures.map((f) => f.case)).toContain("a class declaring a method");
  });

  it("catches a class containing something that is not the method's node", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("holdsProperty", [["class:1", "load", "fn:a"]]);
      db.add("holdsProperty", ["class:1", "load", "f#load"]);
      return db;
    });
    expect(failures.map((f) => f.problem).join(" ")).toContain(
      "not the node that declares the method",
    );
  });

  it("catches constructor parameters keyed on something other than the class", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("paramOf", [["class:1", "0", "class:1#source"]]);
      db.add("paramOf", ["class:1#ctor", "0", "class:1#source"]);
      return db;
    });
    expect(failures.map((f) => f.problem).join(" ")).toContain(
      "none of its constructor's parameters",
    );
  });

  it("catches a construction written down as something other than a call", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("call", [["call:1", "f#build"]]);
      return db;
    });
    expect(failures.map((f) => f.problem).join(" ")).toContain(
      "not written down as a call",
    );
  });

  it("catches a construction that passes its argument nowhere", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("callArg", [["call:1", "0", "f#source"]]);
      return db;
    });
    expect(failures.map((f) => f.case)).toContain(
      "a class constructed with an argument",
    );
  });

  it("catches a call that is not a written value", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("writtenValue", [["call:1"]]);
      return db;
    });
    expect(failures.map((f) => f.problem).join(" ")).toContain(
      "not a written value",
    );
  });

  it("catches a call the rules were given a comesTo for", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.add("comesTo", ["call:1", "fn:a"]);
      return db;
    });
    expect(failures.map((f) => f.problem).join(" ")).toContain(
      "withhold on purpose",
    );
  });

  it("catches a sequence that keeps its elements under something other than positions", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("holdsProperty", [["list:1", "0", "f#first"]]);
      db.add("holdsProperty", ["list:1", "first", "f#first"]);
      return db;
    });
    expect(failures.map((f) => f.case)).toContain("a written-out sequence");
  });

  it("catches a module exporting something other than the declaring node", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("exportsAs", [["f.py", "build", "fn:a"]]);
      db.add("exportsAs", ["f.py", "build", "f.py#build"]);
      return db;
    });
    expect(failures.map((f) => f.case)).toContain("a module exporting a name");
  });

  it("catches a file that reaches nothing another file declares", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("imports", [["f.py#renamed", "source.py", "value"]]);
      return db;
    });
    expect(failures.map((f) => f.case)).toContain(
      "a value another file declares",
    );
  });

  it("accepts a binding straight to a definition in the other file", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("imports", [["f.py#renamed", "source.py", "value"]]);
      db.add("binds", ["f.py#Order", "source.py:0-12"]);
      return db;
    });
    expect(failures).toEqual([]);
  });

  it("accepts a read linked to its parameter by binds rather than keyed as it", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("returnsValue", [["fn:a", "fn:a#loader"]]);
      db.add("returnsValue", ["fn:a", "read:1"]);
      db.add("binds", ["read:1", "fn:a#loader"]);
      return db;
    });
    expect(failures).toEqual([]);
  });

  it("catches a fallback whose branch is not the value node itself", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("fallbackBranch", [["or:1", "call:1"]]);
      db.add("fallbackBranch", ["or:1", "f#build()"]);
      return db;
    });
    expect(failures.map((f) => f.problem).join(" ")).toContain(
      "cannot continue into the branch",
    );
  });

  it("catches a fallback whose branches are keyed apart", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("fallbackBranch", [["or:1", "f#cached"]]);
      db.add("fallbackBranch", ["or:2", "f#cached"]);
      return db;
    });
    expect(failures.map((f) => f.problem).join(" ")).toContain(
      "keyed under different expressions",
    );
  });

  it("says which case has no source rather than passing it", async () => {
    const failures = await checkFactContract({}, conformingFacts);
    expect(failures).toHaveLength(FACT_CONTRACT_CASES.length);
    expect(failures[0]?.problem).toContain("no source supplied");
  });

  it("keeps quiet about a case written down as a known gap", async () => {
    const failures = await checkFactContract(
      everyCase,
      () => {
        const db = conformingFacts();
        db.retract("imports", [["f.py#renamed", "source.py", "value"]]);
        return db;
      },
      {
        known: {
          "a value another file declares": "nothing crosses a file yet",
        },
      },
    );
    expect(failures).toEqual([]);
  });

  it("reports a known gap that has started passing, so the list cannot rot", async () => {
    const failures = await checkFactContract(everyCase, conformingFacts, {
      known: { "a written-out sequence": "not done yet" },
    });
    expect(failures.map((f) => f.problem).join(" ")).toContain(
      "take it off the list",
    );
  });
  it("says what a case needed when the source produced none of it", async () => {
    const failures = await checkFactContract(everyCase, () => new Database());
    expect(failures).toHaveLength(FACT_CONTRACT_CASES.length);
    const problems = failures.map((f) => f.problem).join(" | ");
    expect(problems).toContain("expected two parameters");
    expect(problems).toContain("expected one parameter and one return");
    expect(problems).toContain("expected one call");
    expect(problems).toContain("not an object value");
    expect(problems).toContain("exports nothing");
  });

  it("says a sequence keeps no elements when it is an object with none", async () => {
    const failures = await checkFactContract(everyCase, () => {
      const db = conformingFacts();
      db.retract("holdsProperty", [
        ["list:1", "0", "f#first"],
        ["list:1", "1", "f#second"],
      ]);
      return db;
    });
    expect(failures.map((f) => f.problem).join(" ")).toContain(
      "keeps no elements",
    );
  });
});
