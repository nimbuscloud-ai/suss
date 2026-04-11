import { describe, it, expect } from "vitest";
import { assembleSummary, RawCodeStructure } from "./index.js";

const twoPathRaw: RawCodeStructure = {
  identity: {
    name: "getUser",
    kind: "handler",
    file: "src/handlers/users.ts",
    range: { start: 10, end: 25 },
    exportName: "getUser",
    exportPath: ["getUser"],
  },
  boundaryBinding: { protocol: "http", method: "GET", path: "/users/:id", framework: "express" },
  parameters: [
    { name: "req", position: 0, role: "request", typeText: "Request" },
    { name: "res", position: 1, role: "response", typeText: "Response" },
  ],
  branches: [
    {
      conditions: [
        {
          sourceText: "!user",
          structured: {
            type: "truthinessCheck",
            subject: { type: "dependency", name: "db.findById", accessChain: [] },
            negated: true,
          },
          polarity: "positive",
          source: "explicit",
        },
      ],
      terminal: {
        kind: "response",
        statusCode: { type: "literal", value: 404 },
        body: { typeText: null, shape: { error: "not found" } },
        exceptionType: null,
        message: null,
        location: { start: 16, end: 16 },
      },
      effects: [],
      location: { start: 15, end: 17 },
      isDefault: false,
    },
    {
      conditions: [],
      terminal: {
        kind: "response",
        statusCode: { type: "literal", value: 200 },
        body: { typeText: "User", shape: null },
        exceptionType: null,
        message: null,
        location: { start: 20, end: 20 },
      },
      effects: [],
      location: { start: 18, end: 22 },
      isDefault: true,
    },
  ],
  dependencyCalls: [
    {
      name: "db.findById",
      assignedTo: "user",
      async: true,
      returnType: "User | null",
      location: { start: 12, end: 12 },
    },
  ],
  declaredContract: null,
};

describe("assembleSummary", () => {
  it("produces a valid summary from a two-branch handler", () => {
    const summary = assembleSummary(twoPathRaw);
    expect(summary.kind).toBe("handler");
    expect(summary.transitions).toHaveLength(2);
    expect(summary.transitions[0].output.type).toBe("response");
    expect(summary.transitions[1].isDefault).toBe(true);
    expect(summary.gaps).toHaveLength(0);
    expect(summary.confidence.level).toBe("high");
  });

  it("degrades confidence to low when predicates are all opaque", () => {
    const raw: RawCodeStructure = {
      ...twoPathRaw,
      branches: [
        {
          ...twoPathRaw.branches[0],
          conditions: [
            {
              sourceText: "someComplexCheck()",
              structured: {
                type: "opaque",
                sourceText: "someComplexCheck()",
                reason: "complexExpression",
              },
              polarity: "positive",
              source: "explicit",
            },
          ],
        },
        twoPathRaw.branches[1],
      ],
    };
    const summary = assembleSummary(raw);
    expect(summary.confidence.level).toBe("low");
  });

  it("detects a gap when declared contract has status not produced", () => {
    const raw: RawCodeStructure = {
      ...twoPathRaw,
      declaredContract: {
        responses: [
          { statusCode: 200 },
          { statusCode: 404 },
          { statusCode: 500 }, // not produced
        ],
      },
    };
    const summary = assembleSummary(raw, { gapHandling: "strict" });
    expect(summary.gaps).toHaveLength(1);
    expect(summary.gaps[0].consequence).toContain("500");
  });

  it("returns no gaps when gapHandling is silent", () => {
    const raw: RawCodeStructure = {
      ...twoPathRaw,
      declaredContract: {
        responses: [{ statusCode: 200 }, { statusCode: 500 }],
      },
    };
    const summary = assembleSummary(raw, { gapHandling: "silent" });
    expect(summary.gaps).toHaveLength(0);
  });

  it("marks the default transition (empty conditions array)", () => {
    const summary = assembleSummary(twoPathRaw);
    const defaultTransition = summary.transitions.find((t) => t.isDefault);
    expect(defaultTransition).toBeDefined();
    expect(defaultTransition!.conditions).toHaveLength(0);
  });
});
