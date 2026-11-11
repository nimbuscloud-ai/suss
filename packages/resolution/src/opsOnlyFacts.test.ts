// The facts that place a body's calls in order and state the pairs a call
// passes are read by the ops in @suss/recognize/ops and by no rule, so an
// adapter stating them changes no answer the rules give.

import { describe, expect, it } from "vitest";

import { resolutionProgram, resolutionUnderProgram } from "./program.js";

const READ_BY_OPS_ONLY = ["bodyCallAt", "callPairArg"];

describe("the facts only the ops read", () => {
  it("appear in the body of no rule", () => {
    const read = new Set(
      [resolutionProgram(), resolutionUnderProgram()].flatMap((program) =>
        program.rules.flatMap((rule) =>
          rule.body.map((literal) => literal.relation),
        ),
      ),
    );
    expect(read.size).toBeGreaterThan(0);
    expect(READ_BY_OPS_ONLY.filter((relation) => read.has(relation))).toEqual(
      [],
    );
  });
});
