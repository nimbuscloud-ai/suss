// The renderer over witness proofs: run the resolution rules on a
// small fact base, reconstruct one answer's proof, and check the chain
// comes out as the sentences a person would accept.

import { describe, expect, it } from "vitest";

import {
  Database,
  evaluate,
  lit,
  proofOf,
  rule,
  variable as v,
  witnesses,
} from "@suss/datalog";

import { explainResolutionProof, renderExplanation } from "./explain.js";
import { RESOLUTION_RULES, VALUE_STEP } from "./index.js";

import type { Atom } from "@suss/datalog";

function evaluated(facts: Array<[string, ...string[]]>): Database {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  evaluate(db, RESOLUTION_RULES, witnesses);
  return db;
}

const say = (atom: Atom): string => String(atom);

describe("explainResolutionProof", () => {
  it("renders an import chain as one hop per step", () => {
    const db = evaluated([
      ["func", "handlerFn"],
      ["exportsAs", "lib", "handler", "handlerFn"],
      ["imports", "h", "lib", "handler"],
      ["binds", "x", "h"],
    ]);

    const proof = proofOf(db, "resolves", ["x", "handlerFn"]);
    const explained = explainResolutionProof(proof, { describe: say });

    expect(explained).not.toBeNull();
    expect(explained?.atoms).toEqual(["x", "h", "handlerFn"]);
    expect(explained?.steps.map((step) => step.rule)).toEqual([
      "alias",
      "import",
    ]);
    expect(explained?.steps[0].reason).toBe("x is declared as h");
    expect(explained?.steps[1].reason).toBe(
      "h is imported from lib under the name handler",
    );
    expect(explained?.truncated).toBe(false);
  });

  it("says which barrels forwarded a re-exported name", () => {
    const db = evaluated([
      ["func", "daoFn"],
      ["exportsAs", "inner", "dao", "daoFn"],
      ["reExports", "barrel", "dao", "inner", "dao"],
      ["imports", "d", "barrel", "dao"],
    ]);

    const proof = proofOf(db, "resolves", ["d", "daoFn"]);
    const explained = explainResolutionProof(proof, { describe: say });

    expect(explained?.steps).toHaveLength(1);
    expect(explained?.steps[0].notes).toEqual([
      "barrel takes dao from inner, where it is called dao",
    ]);
  });

  it("renders a factory unwrap with the factory's own chain inline", () => {
    // const wrapped = makeHandler(inner), where makeHandler is imported
    // and returns a function that calls its parameter.
    const db = evaluated([
      ["func", "factoryFn"],
      ["func", "returnedFn"],
      ["func", "innerFn"],
      ["paramOf", "factoryFn", "0", "param"],
      ["returnsValue", "factoryFn", "returnedFn"],
      ["binds", "callInside", "param"],
      ["bodyCalls", "returnedFn", "callInside"],
      ["exportsAs", "lib", "makeHandler", "factoryFn"],
      ["imports", "mk", "lib", "makeHandler"],
      ["call", "wrapped", "mk"],
      ["callArg", "wrapped", "0", "innerFn"],
      ["binds", "h", "wrapped"],
    ]);

    const proof = proofOf(db, "resolves", ["h", "innerFn"]);
    const explained = explainResolutionProof(proof, { describe: say });

    expect(explained?.atoms).toEqual(["h", "wrapped", "innerFn"]);
    const unwrap = explained?.steps[1];
    expect(unwrap?.rule).toBe("factory unwrap");
    expect(unwrap?.reason).toBe(
      "wrapped calls factoryFn, a factory that passes its argument through, so it comes down to innerFn",
    );
    // The factory arrived through an import, and that chain shows
    // under the hop rather than vanishing into it.
    expect(unwrap?.notes).toContain(
      "mk is imported from lib under the name makeHandler",
    );
  });

  it("surfaces a pack-declared wrapper as an assumption", () => {
    const db = evaluated([
      ["func", "innerFn"],
      ["calleeName", "wrapped", "withSentry"],
      ["unwrapsByName", "withSentry", "0"],
      ["wrapperModule", "withSentry", "@sentry/serverless"],
      ["calleeOrigin", "wrapped", "@sentry/serverless"],
      ["callArg", "wrapped", "0", "innerFn"],
      ["binds", "h", "wrapped"],
    ]);

    const proof = proofOf(db, "resolves", ["h", "innerFn"]);
    const explained = explainResolutionProof(proof, { describe: say });

    expect(explained?.assumptions).toEqual([
      "a pack declares that withSentry from @sentry/serverless passes argument 0 through to its result",
    ]);
    const lines = renderExplanation(explained!, say);
    expect(lines).toContain(
      "  assuming a pack declares that withSentry from @sentry/serverless passes argument 0 through to its result",
    );
  });

  it("says when the depth cap stopped the walk", () => {
    const facts: Array<[string, ...string[]]> = [["func", "end"]];
    let previous = "end";
    for (let i = 0; i < 10; i++) {
      facts.push(["binds", `n${i}`, previous]);
      previous = `n${i}`;
    }
    const db = evaluated(facts);

    const proof = proofOf(db, "resolves", [previous, "end"], { maxDepth: 4 });
    const explained = explainResolutionProof(proof, { describe: say });

    expect(explained?.truncated).toBe(true);
    const lines = renderExplanation(explained!, say);
    expect(lines[lines.length - 1]).toBe(
      "  the chain goes on past the proof depth cap",
    );
  });

  it("returns null for a fact that was never derived", () => {
    const db = evaluated([["func", "f"]]);
    const proof = proofOf(db, "resolves", ["ghost", "f"]);

    expect(explainResolutionProof(proof, { describe: say })).toBeNull();
  });

  it("returns null for a relation whose proof is not a chain", () => {
    const db = evaluated([["exportsAs", "lib", "n", "f"]]);
    const proof = proofOf(db, "moduleExport", ["lib", "n", "f"]);

    expect(explainResolutionProof(proof, { describe: say })).toBeNull();
  });

  it("says what a rewritten name ends up as", () => {
    const db = evaluated([
      ["func", "second"],
      ["endsHolding", "x", "second"],
    ]);

    const proof = proofOf(db, "resolves", ["x", "second"]);
    const explained = explainResolutionProof(proof, { describe: say });

    expect(explained?.steps[0].rule).toBe("last write");
    expect(explained?.steps[0].reason).toBe(
      "x is written more than once, and the last write leaves it as second",
    );
  });

  it("says which call put a value in a parameter", () => {
    const db = evaluated([
      ["func", "wrapperFn"],
      ["func", "innerFn"],
      ["paramOf", "wrapperFn", "0", "p"],
      ["binds", "wname", "wrapperFn"],
      ["call", "r", "wname"],
      ["callArg", "r", "0", "innerFn"],
    ]);

    const proof = proofOf(db, "resolves", ["p", "innerFn"]);
    const explained = explainResolutionProof(proof, { describe: say });

    expect(explained?.steps[0].rule).toBe("argument");
    expect(explained?.steps[0].reason).toBe(
      "p is a parameter of wrapperFn, and a call passes it innerFn",
    );
  });

  it("says which property an expression read, and off what", () => {
    const db = evaluated([
      ["func", "listFn"],
      ["objectValue", "routesObj"],
      ["holdsProperty", "routesObj", "list", "listFn"],
      ["binds", "routes", "routesObj"],
      ["readsProperty", "expr", "routes", "list"],
    ]);

    const proof = proofOf(db, "resolves", ["expr", "listFn"]);
    const explained = explainResolutionProof(proof, { describe: say });

    expect(explained?.steps[0].rule).toBe("property read");
    expect(explained?.steps[0].reason).toBe(
      "expr reads list off routes, which contains listFn",
    );
  });

  it("says a call makes an instance of its class", () => {
    const db = evaluated([
      ["objectValue", "clsObj"],
      ["binds", "cname", "clsObj"],
      ["call", "r", "cname"],
      ["binds", "x", "r"],
    ]);

    const proof = proofOf(db, "comesTo", ["x", "clsObj"]);
    const explained = explainResolutionProof(proof, { describe: say });

    const instance = explained?.steps.find(
      (step) => step.rule === "class instance",
    );
    expect(instance?.reason).toBe("r makes an instance of clsObj");
    expect(instance?.notes).toContain("cname is declared as clsObj");
  });

  it("says what a call runs and what that returns", () => {
    const db = evaluated([
      ["func", "makerFn"],
      ["func", "returnedFn"],
      ["binds", "mk", "makerFn"],
      ["call", "r", "mk"],
      ["returnsValue", "makerFn", "returnedFn"],
    ]);

    const proof = proofOf(db, "givesBack", ["r", "returnedFn"]);
    const explained = explainResolutionProof(proof, { describe: say });

    expect(explained?.steps[0].rule).toBe("call result");
    expect(explained?.steps[0].reason).toBe(
      "r runs makerFn, which returns returnedFn",
    );
    expect(explained?.steps[0].notes).toContain("mk is declared as makerFn");
  });

  it("ends a comesFrom chain at the import", () => {
    const db = evaluated([
      ["imports", "h", "some-lib", "handler"],
      ["binds", "x", "h"],
    ]);

    const proof = proofOf(db, "comesFrom", ["x", "some-lib", "handler"]);
    const explained = explainResolutionProof(proof, { describe: say });

    expect(explained?.steps.map((step) => step.rule)).toEqual([
      "alias",
      "import",
    ]);
    expect(explained?.steps[1].reason).toBe(
      "h is imported from some-lib under the name handler",
    );

    const direct = proofOf(db, "comesFrom", ["h", "some-lib", "handler"]);
    const directExplained = explainResolutionProof(direct, { describe: say });
    expect(directExplained?.steps.map((step) => step.rule)).toEqual(["import"]);
  });

  it("says a barrel forwards everything another module exports", () => {
    const db = evaluated([
      ["func", "daoFn"],
      ["exportsAs", "inner", "dao", "daoFn"],
      ["reExportsAll", "barrel", "inner"],
      ["imports", "d", "barrel", "dao"],
    ]);

    const proof = proofOf(db, "resolves", ["d", "daoFn"]);
    const explained = explainResolutionProof(proof, { describe: say });

    expect(explained?.steps[0].notes).toEqual([
      "barrel forwards everything inner exports",
    ]);
    const lines = renderExplanation(explained!, say);
    expect(lines).toContain("    barrel forwards everything inner exports");
  });

  it("renders a step rule it has no phrase for by its label", () => {
    const custom = [
      ...RESOLUTION_RULES,
      rule(
        "stepsTo",
        [v("x"), v("y"), VALUE_STEP],
        [lit("customHop", v("x"), v("y"))],
        "custom hop",
      ),
    ];
    const db = new Database();
    db.add("func", ["target"]);
    db.add("customHop", ["x", "target"]);
    evaluate(db, custom, witnesses);

    const proof = proofOf(db, "resolves", ["x", "target"]);
    const explained = explainResolutionProof(proof, { describe: say });

    expect(explained?.steps[0].reason).toBe("x steps to target (custom hop)");
  });
});
