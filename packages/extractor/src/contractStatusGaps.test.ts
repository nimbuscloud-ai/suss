import { describe, expect, it } from "vitest";

import { withWrapperMetadata } from "@suss/behavioral-ir";

import { contractStatusGaps } from "./contractStatusGaps.js";

import type { Transition, WrapperReference } from "@suss/behavioral-ir";

function responds(id: string, status: number, from?: string): Transition {
  const transition: Transition = {
    id,
    conditions: [],
    output: {
      type: "response",
      statusCode: { type: "literal", value: status },
      body: null,
      headers: {},
    },
    effects: [],
    location: { start: 1, end: 1 },
    isDefault: true,
  };
  if (from === undefined) {
    return transition;
  }
  const reference: WrapperReference = { file: `src/${from}.ts`, name: from };
  return {
    ...transition,
    metadata: withWrapperMetadata(undefined, { from: reference }),
  };
}

function throws(id: string): Transition {
  return {
    id,
    conditions: [],
    output: { type: "throw", exceptionType: "Error", message: null },
    effects: [],
    location: { start: 1, end: 1 },
    isDefault: false,
  };
}

const contract = (...statuses: number[]) => ({
  framework: "express",
  responses: statuses.map((statusCode) => ({ statusCode })),
});

const descriptions = (
  declared: ReturnType<typeof contract>,
  transitions: Transition[],
): string[] =>
  contractStatusGaps(declared, transitions).map((gap) => gap.description);

describe("contractStatusGaps", () => {
  it("reports nothing when the outcomes and the contract agree", () => {
    expect(
      descriptions(contract(200, 404), [
        responds("ok", 200),
        responds("missing", 404),
      ]),
    ).toEqual([]);
  });

  it("reports a declared status nothing produces", () => {
    const gaps = contractStatusGaps(contract(200, 404), [responds("ok", 200)]);

    expect(gaps).toEqual([
      {
        type: "unhandledCase",
        conditions: [],
        consequence: "frameworkDefault",
        description: "Declared response 404 is never produced by the handler",
      },
    ]);
  });

  it("reports a status the handler produces that the contract leaves out", () => {
    const gaps = contractStatusGaps(contract(200), [
      responds("ok", 200),
      responds("bad", 400),
    ]);

    expect(gaps).toEqual([
      {
        type: "unhandledCase",
        conditions: [],
        consequence: "unknown",
        description:
          "Handler produces status 400 which is not declared in the express contract",
      },
    ]);
  });

  it("says which wrappers produced an undeclared status", () => {
    expect(
      descriptions(contract(200), [
        responds("ok", 200),
        responds("limited", 429, "rateLimit"),
        responds("denied", 429, "requireCaller"),
      ]),
    ).toEqual([
      "rateLimit and requireCaller, registered around this handler, produces status 429 which is not declared in the express contract",
    ]);
  });

  it("credits the handler when both it and a wrapper produce a status", () => {
    expect(
      descriptions(contract(200), [
        responds("denied", 401, "requireCaller"),
        responds("ok", 200),
        responds("unauthorized", 401),
      ]),
    ).toEqual([
      "Handler produces status 401 which is not declared in the express contract",
    ]);
  });

  it("ignores throws and statuses that are not literal", () => {
    const computed: Transition = {
      ...responds("dynamic", 200),
      output: {
        type: "response",
        statusCode: { type: "unresolved", sourceText: "code" },
        body: null,
        headers: {},
      },
    };

    expect(descriptions(contract(200), [computed, throws("boom")])).toEqual([
      "Declared response 200 is never produced by the handler",
    ]);
  });
});
