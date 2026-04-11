import { describe, it, expect } from "vitest";
import { assembleSummary, type RawCodeStructure } from "./index.js";

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

  it("wraps null-structured conditions as opaque predicates — never drops them", () => {
    const raw: RawCodeStructure = {
      ...twoPathRaw,
      branches: [
        {
          ...twoPathRaw.branches[0],
          conditions: [
            {
              sourceText: "someComplexCheck()",
              structured: null, // adapter couldn't parse this
              polarity: "positive",
              source: "explicit",
            },
          ],
        },
        twoPathRaw.branches[1],
      ],
    };
    const summary = assembleSummary(raw);
    // The condition must appear in the transition as an opaque predicate, not be dropped
    expect(summary.transitions[0].conditions).toHaveLength(1);
    expect(summary.transitions[0].conditions[0].type).toBe("opaque");
  });

  it("wraps negative polarity null-structured conditions as negation of opaque", () => {
    const raw: RawCodeStructure = {
      ...twoPathRaw,
      branches: [
        {
          ...twoPathRaw.branches[0],
          conditions: [
            {
              sourceText: "!complexCheck()",
              structured: null,
              polarity: "negative",
              source: "earlyReturn",
            },
          ],
        },
        twoPathRaw.branches[1],
      ],
    };
    const summary = assembleSummary(raw);
    expect(summary.transitions[0].conditions[0].type).toBe("negation");
    if (summary.transitions[0].conditions[0].type === "negation") {
      expect(summary.transitions[0].conditions[0].operand.type).toBe("opaque");
    }
  });

  it("degrades confidence to low when all conditions are opaque", () => {
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

  it("detects a gap when declared contract declares a status never produced", () => {
    const raw: RawCodeStructure = {
      ...twoPathRaw,
      declaredContract: {
        framework: "ts-rest",
        responses: [
          { statusCode: 200 },
          { statusCode: 404 },
          { statusCode: 500 }, // never produced
        ],
      },
    };
    const summary = assembleSummary(raw, { gapHandling: "strict" });
    expect(summary.gaps).toHaveLength(1);
    expect(summary.gaps[0].description).toContain("500");
    expect(summary.gaps[0].consequence).toBe("frameworkDefault");
  });

  it("detects a gap when handler produces a status not declared in the contract", () => {
    // twoPathRaw produces 200 and 404. Declare only 200 — the 404 is a contract violation.
    const raw: RawCodeStructure = {
      ...twoPathRaw,
      declaredContract: {
        framework: "ts-rest",
        responses: [{ statusCode: 200 }],
      },
    };
    const summary = assembleSummary(raw, { gapHandling: "strict" });
    const violation = summary.gaps.find((g) => g.description.includes("404"));
    expect(violation).toBeDefined();
    expect(violation!.description).toContain("not declared");
  });

  it("returns no gaps when gapHandling is silent", () => {
    const raw: RawCodeStructure = {
      ...twoPathRaw,
      declaredContract: {
        framework: "ts-rest",
        responses: [{ statusCode: 200 }, { statusCode: 500 }],
      },
    };
    const summary = assembleSummary(raw, { gapHandling: "silent" });
    expect(summary.gaps).toHaveLength(0);
  });

  it("marks the default transition (empty conditions array)", () => {
    const summary = assembleSummary(twoPathRaw);
    const def = summary.transitions.find((t) => t.isDefault);
    expect(def).toBeDefined();
    expect(def!.conditions).toHaveLength(0);
  });

  it("output statusCode is a ValueRef literal, not a raw number", () => {
    const summary = assembleSummary(twoPathRaw);
    const t = summary.transitions[0];
    expect(t.output.type).toBe("response");
    if (t.output.type === "response") {
      expect(t.output.statusCode?.type).toBe("literal");
      if (t.output.statusCode?.type === "literal") {
        expect(t.output.statusCode.value).toBe(404);
      }
    }
  });
});
