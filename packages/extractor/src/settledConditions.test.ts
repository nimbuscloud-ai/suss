import { describe, expect, it } from "vitest";

import { assembleSummary } from "./index.js";
import { withSettledCondition } from "./settledConditions.js";

import type { RawBranch, RawCodeStructure, RawCondition } from "./index.js";
import type { SettledCondition } from "./settledConditions.js";

/** `!order`, on the branch that needs it true or the one that needs it false. */
function notOrder(polarity: RawCondition["polarity"]): RawCondition {
  return {
    sourceText: "!order",
    structured: {
      type: "truthinessCheck",
      subject: { type: "dependency", name: "loadOrder", accessChain: [] },
      negated: true,
    },
    polarity,
    source: "explicit",
  };
}

const ALWAYS_AN_OBJECT: SettledCondition = {
  truth: false,
  values: { type: "record", properties: {} },
  every: "truthy",
};

function branch(status: number, conditions: RawCondition[]): RawBranch {
  return {
    conditions,
    terminal: {
      kind: "response",
      statusCode: { type: "literal", value: status },
      body: null,
      exceptionType: null,
      message: null,
      component: null,
      delegateTarget: null,
      emitEvent: null,
      renderTree: null,
      location: { start: 4, end: 4 },
    },
    effects: [],
    location: { start: 4, end: 4 },
    isDefault: conditions.length === 0,
  };
}

function route(branches: RawBranch[]): RawCodeStructure {
  return {
    identity: {
      name: "get",
      kind: "handler",
      file: "src/orders.ts",
      range: { start: 1, end: 8 },
      exportName: null,
      exportPath: null,
    },
    boundaryBinding: null,
    parameters: [],
    branches,
    dependencyCalls: [],
    declaredContract: null,
  };
}

describe("withSettledCondition", () => {
  it("marks the branch that needs the answer the condition never gives", () => {
    const answers = new Map<string, SettledCondition | null>();
    const marked = withSettledCondition(
      notOrder("positive"),
      "!order",
      answers,
      () => ALWAYS_AN_OBJECT,
    );
    expect(marked.neverHolds).toEqual({
      values: { type: "record", properties: {} },
      every: "truthy",
    });
    const other = withSettledCondition(
      notOrder("negative"),
      "!order",
      answers,
      () => {
        throw new Error("the answer was kept");
      },
    );
    expect(other.neverHolds).toBeUndefined();
  });

  it("leaves a condition alone when nothing settles it, or when it reads an input", () => {
    expect(
      withSettledCondition(
        notOrder("positive"),
        "!order",
        new Map(),
        () => null,
      ).neverHolds,
    ).toBeUndefined();
    const onInput: RawCondition = {
      ...notOrder("positive"),
      structured: {
        type: "truthinessCheck",
        subject: {
          type: "derived",
          from: { type: "input", inputRef: "req", path: [] },
          derivation: { type: "propertyAccess", property: "user" },
        },
        negated: true,
      },
    };
    expect(
      withSettledCondition(onInput, "!req.user", new Map(), () => {
        throw new Error("an input was asked about");
      }),
    ).toBe(onInput);
    expect(
      withSettledCondition(notOrder("positive"), null, new Map(), () => {
        throw new Error("a condition with no expression was asked about");
      }).neverHolds,
    ).toBeUndefined();
  });
});

describe("assembleSummary with a condition that can never be true", () => {
  it("says which condition and why on the transition", () => {
    const answers = new Map<string, SettledCondition | null>();
    const settle = (condition: RawCondition): RawCondition =>
      withSettledCondition(
        condition,
        "!order",
        answers,
        () => ALWAYS_AN_OBJECT,
      );
    const summary = assembleSummary(
      route([
        branch(404, [settle(notOrder("positive"))]),
        branch(200, [settle(notOrder("negative"))]),
      ]),
    );
    const [missing, found] = summary.transitions;
    expect(missing?.unreachable).toEqual({
      condition: 0,
      values: { type: "record", properties: {} },
      every: "truthy",
    });
    expect(found?.unreachable).toBeUndefined();
    expect(missing?.conditions[0]).not.toHaveProperty("neverHolds");
  });
});
