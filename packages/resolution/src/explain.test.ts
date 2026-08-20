// The renderer over witness proofs: run the resolution rules on a
// small fact base, reconstruct one answer's proof, and check the chain
// comes out as the sentences a person would accept.

import { describe, expect, it } from "vitest";

import { Database, evaluate, proofOf, witnesses } from "@suss/datalog";

import { explainResolutionProof, renderExplanation } from "./explain.js";
import { RESOLUTION_RULES } from "./index.js";

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
});
