import { describe, expect, it } from "vitest";

import {
  assembleSummary,
  assessConfidence,
  detectGaps,
  effectToIR,
  makeTransitionId,
  paramToInput,
  type RawBranch,
  type RawCodeStructure,
  type RawEffect,
  type RawParameter,
  type RawTerminal,
  terminalToOutput,
} from "./index.js";

// Minimal RawTerminal builder — every call site overrides only the fields it cares about.
const makeTerminal = (overrides: Partial<RawTerminal>): RawTerminal => ({
  kind: "void",
  statusCode: null,
  body: null,
  exceptionType: null,
  message: null,
  component: null,
  renderTree: null,
  delegateTarget: null,
  emitEvent: null,
  location: { start: 0, end: 0 },
  ...overrides,
});

const twoPathRaw: RawCodeStructure = {
  identity: {
    name: "getUser",
    kind: "handler",
    file: "src/handlers/users.ts",
    range: { start: 10, end: 25 },
    exportName: "getUser",
    exportPath: ["getUser"],
  },
  boundaryBinding: {
    transport: "http",
    semantics: { name: "rest", method: "GET", path: "/users/:id" },
    recognition: "express",
  },
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
            subject: {
              type: "dependency",
              name: "db.findById",
              accessChain: [],
            },
            negated: true,
          },
          polarity: "positive",
          source: "explicit",
        },
      ],
      terminal: {
        kind: "response",
        statusCode: { type: "literal", value: 404 },
        body: {
          typeText: null,
          shape: {
            type: "record",
            properties: { error: { type: "text" } },
          },
        },
        exceptionType: null,
        message: null,
        component: null,
        delegateTarget: null,
        emitEvent: null,
        renderTree: null,
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
        component: null,
        delegateTarget: null,
        emitEvent: null,
        renderTree: null,
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
    expect(violation?.description).toContain("not declared");
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
    expect(def?.conditions).toHaveLength(0);
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

describe("makeTransitionId", () => {
  // Minimal branch builder — callers supply only the fields that matter.
  const makeBranch = (overrides: Partial<RawBranch>): RawBranch => ({
    conditions: [],
    terminal: makeTerminal({ kind: "void" }),
    effects: [],
    location: { start: 0, end: 0 },
    isDefault: false,
    ...overrides,
  });

  it("is deterministic — same input, same ID", () => {
    const branch = makeBranch({
      conditions: [
        {
          sourceText: "!user",
          structured: null,
          polarity: "positive",
          source: "explicit",
        },
      ],
      terminal: makeTerminal({
        kind: "response",
        statusCode: { type: "literal", value: 404 },
      }),
    });
    expect(makeTransitionId("getUser", branch)).toBe(
      makeTransitionId("getUser", branch),
    );
  });

  it("is stable under branch reordering — sibling branches do not affect each other's IDs", () => {
    // The defining property: reshuffling the `branches` array does not
    // change any individual branch's ID.
    const raw: RawCodeStructure = {
      ...twoPathRaw,
      branches: [twoPathRaw.branches[0], twoPathRaw.branches[1]],
    };
    const reordered: RawCodeStructure = {
      ...twoPathRaw,
      branches: [twoPathRaw.branches[1], twoPathRaw.branches[0]],
    };
    const original = assembleSummary(raw);
    const swapped = assembleSummary(reordered);

    const originalIds = new Set(original.transitions.map((t) => t.id));
    const swappedIds = new Set(swapped.transitions.map((t) => t.id));
    expect(originalIds).toEqual(swappedIds);
  });

  it("adding a new branch leaves existing branches' IDs unchanged", () => {
    const before = assembleSummary(twoPathRaw);
    const withExtra = assembleSummary({
      ...twoPathRaw,
      branches: [
        ...twoPathRaw.branches,
        {
          conditions: [
            {
              sourceText: "someOther",
              structured: null,
              polarity: "positive",
              source: "explicit",
            },
          ],
          terminal: makeTerminal({
            kind: "response",
            statusCode: { type: "literal", value: 500 },
          }),
          effects: [],
          location: { start: 30, end: 32 },
          isDefault: false,
        },
      ],
    });
    for (const original of before.transitions) {
      const matching = withExtra.transitions.find((t) => t.id === original.id);
      expect(matching).toBeDefined();
    }
  });

  it("different terminal kind mints a different ID", () => {
    const response = makeBranch({
      terminal: makeTerminal({
        kind: "response",
        statusCode: { type: "literal", value: 200 },
      }),
    });
    const thrown = makeBranch({
      terminal: makeTerminal({ kind: "throw" }),
    });
    expect(makeTransitionId("f", response)).not.toBe(
      makeTransitionId("f", thrown),
    );
  });

  it("different literal status code mints a different ID", () => {
    const ok = makeBranch({
      terminal: makeTerminal({
        kind: "response",
        statusCode: { type: "literal", value: 200 },
      }),
    });
    const notFound = makeBranch({
      terminal: makeTerminal({
        kind: "response",
        statusCode: { type: "literal", value: 404 },
      }),
    });
    expect(makeTransitionId("f", ok)).not.toBe(makeTransitionId("f", notFound));
  });

  it("different condition source text mints a different ID", () => {
    const a = makeBranch({
      conditions: [
        {
          sourceText: "!user",
          structured: null,
          polarity: "positive",
          source: "explicit",
        },
      ],
      terminal: makeTerminal({
        kind: "response",
        statusCode: { type: "literal", value: 404 },
      }),
    });
    const b = makeBranch({
      conditions: [
        {
          sourceText: "!admin",
          structured: null,
          polarity: "positive",
          source: "explicit",
        },
      ],
      terminal: makeTerminal({
        kind: "response",
        statusCode: { type: "literal", value: 404 },
      }),
    });
    expect(makeTransitionId("f", a)).not.toBe(makeTransitionId("f", b));
  });

  it("different condition polarity mints a different ID", () => {
    const positive = makeBranch({
      conditions: [
        {
          sourceText: "user.active",
          structured: null,
          polarity: "positive",
          source: "explicit",
        },
      ],
      terminal: makeTerminal({ kind: "void" }),
    });
    const negative = makeBranch({
      conditions: [
        {
          sourceText: "user.active",
          structured: null,
          polarity: "negative",
          source: "explicit",
        },
      ],
      terminal: makeTerminal({ kind: "void" }),
    });
    expect(makeTransitionId("f", positive)).not.toBe(
      makeTransitionId("f", negative),
    );
  });

  it("condition order is part of identity — short-circuit semantics differ", () => {
    // `a && b` and `b && a` can have different evaluation side effects,
    // so the IDs must differ.
    const ab = makeBranch({
      conditions: [
        {
          sourceText: "a",
          structured: null,
          polarity: "positive",
          source: "explicit",
        },
        {
          sourceText: "b",
          structured: null,
          polarity: "positive",
          source: "explicit",
        },
      ],
      terminal: makeTerminal({ kind: "void" }),
    });
    const ba = makeBranch({
      conditions: [
        {
          sourceText: "b",
          structured: null,
          polarity: "positive",
          source: "explicit",
        },
        {
          sourceText: "a",
          structured: null,
          polarity: "positive",
          source: "explicit",
        },
      ],
      terminal: makeTerminal({ kind: "void" }),
    });
    expect(makeTransitionId("f", ab)).not.toBe(makeTransitionId("f", ba));
  });

  it("dynamic status codes keyed by source text (two distinct dynamics → different IDs)", () => {
    const codeA = makeBranch({
      terminal: makeTerminal({
        kind: "response",
        statusCode: { type: "dynamic", sourceText: "computeStatus(a)" },
      }),
    });
    const codeB = makeBranch({
      terminal: makeTerminal({
        kind: "response",
        statusCode: { type: "dynamic", sourceText: "computeStatus(b)" },
      }),
    });
    expect(makeTransitionId("f", codeA)).not.toBe(makeTransitionId("f", codeB));
  });

  it("function name is part of identity — same branch in two functions mints distinct IDs", () => {
    const branch = makeBranch({
      terminal: makeTerminal({
        kind: "response",
        statusCode: { type: "literal", value: 200 },
      }),
    });
    expect(makeTransitionId("getUser", branch)).not.toBe(
      makeTransitionId("getAdmin", branch),
    );
  });

  it("relocating a branch (changing its location range) leaves the ID intact", () => {
    // Identity is content-addressable — editing whitespace that shifts the
    // branch's start/end offsets should not re-mint the ID.
    const original = makeBranch({
      conditions: [
        {
          sourceText: "!user",
          structured: null,
          polarity: "positive",
          source: "explicit",
        },
      ],
      terminal: makeTerminal({
        kind: "response",
        statusCode: { type: "literal", value: 404 },
        location: { start: 16, end: 16 },
      }),
      location: { start: 15, end: 17 },
    });
    const moved = makeBranch({
      ...original,
      terminal: { ...original.terminal, location: { start: 99, end: 99 } },
      location: { start: 98, end: 100 },
    });
    expect(makeTransitionId("f", original)).toBe(makeTransitionId("f", moved));
  });
});

describe("terminalToOutput", () => {
  it("converts a response with a literal status code to a ValueRef literal", () => {
    const out = terminalToOutput(
      makeTerminal({
        kind: "response",
        statusCode: { type: "literal", value: 201 },
        body: { typeText: "CreatedUser", shape: null },
      }),
    );
    expect(out.type).toBe("response");
    if (out.type === "response") {
      expect(out.statusCode).toEqual({ type: "literal", value: 201 });
      expect(out.body).toEqual({ type: "ref", name: "CreatedUser" });
      expect(out.headers).toEqual({});
    }
  });

  it("converts a response with a dynamic status code to a ValueRef unresolved", () => {
    const out = terminalToOutput(
      makeTerminal({
        kind: "response",
        statusCode: { type: "dynamic", sourceText: "computeStatus(user)" },
      }),
    );
    if (out.type === "response") {
      expect(out.statusCode).toEqual({
        type: "unresolved",
        sourceText: "computeStatus(user)",
      });
      expect(out.body).toBeNull();
    }
  });

  it("converts a response with null status code and null body", () => {
    const out = terminalToOutput(makeTerminal({ kind: "response" }));
    if (out.type === "response") {
      expect(out.statusCode).toBeNull();
      expect(out.body).toBeNull();
    }
  });

  it("converts a throw terminal preserving exceptionType and message", () => {
    const out = terminalToOutput(
      makeTerminal({
        kind: "throw",
        exceptionType: "NotFoundError",
        message: "User not found",
      }),
    );
    expect(out).toEqual({
      type: "throw",
      exceptionType: "NotFoundError",
      message: "User not found",
    });
  });

  it("converts throw-with-status to a response output", () => {
    // When a framework pack extracts a status code from a thrown value,
    // the throw is behaviorally a response (the client sees HTTP status).
    const out = terminalToOutput(
      makeTerminal({
        kind: "throw",
        exceptionType: "HttpError",
        message: "Not found",
        statusCode: { type: "literal", value: 404 },
      }),
    );
    expect(out).toEqual({
      type: "response",
      statusCode: { type: "literal", value: 404 },
      body: null,
      headers: {},
    });
  });

  it("converts throw-with-dynamic-status to response with unresolved statusCode", () => {
    const out = terminalToOutput(
      makeTerminal({
        kind: "throw",
        statusCode: { type: "dynamic", sourceText: "errorCode" },
      }),
    );
    expect(out).toEqual({
      type: "response",
      statusCode: { type: "unresolved", sourceText: "errorCode" },
      body: null,
      headers: {},
    });
  });

  it("keeps throw-without-status as a throw output", () => {
    const out = terminalToOutput(
      makeTerminal({
        kind: "throw",
        exceptionType: "Error",
        message: "oops",
      }),
    );
    expect(out).toEqual({
      type: "throw",
      exceptionType: "Error",
      message: "oops",
    });
  });

  it("converts a render terminal, preserving component name", () => {
    const out = terminalToOutput(
      makeTerminal({ kind: "render", component: "UserCard" }),
    );
    expect(out).toEqual({ type: "render", component: "UserCard" });
  });

  it("falls back to 'unknown' when render terminal has no component", () => {
    const out = terminalToOutput(makeTerminal({ kind: "render" }));
    expect(out).toEqual({ type: "render", component: "unknown" });
  });

  it("converts a delegate terminal, preserving target", () => {
    const out = terminalToOutput(
      makeTerminal({ kind: "delegate", delegateTarget: "next()" }),
    );
    expect(out).toEqual({ type: "delegate", to: "next()" });
  });

  it("falls back to 'unknown' when delegate terminal has no target", () => {
    const out = terminalToOutput(makeTerminal({ kind: "delegate" }));
    expect(out).toEqual({ type: "delegate", to: "unknown" });
  });

  it("converts an emit terminal, preserving event name", () => {
    const out = terminalToOutput(
      makeTerminal({ kind: "emit", emitEvent: "user.created" }),
    );
    expect(out).toEqual({ type: "emit", event: "user.created" });
  });

  it("falls back to 'unknown' when emit terminal has no event", () => {
    const out = terminalToOutput(makeTerminal({ kind: "emit" }));
    expect(out).toEqual({ type: "emit", event: "unknown" });
  });

  it("converts a return terminal carrying a typed body to a TypeShape ref", () => {
    const out = terminalToOutput(
      makeTerminal({
        kind: "return",
        body: { typeText: "User", shape: null },
      }),
    );
    expect(out).toEqual({
      type: "return",
      value: { type: "ref", name: "User" },
    });
  });

  it("converts a return terminal with no body to a null value", () => {
    const out = terminalToOutput(makeTerminal({ kind: "return" }));
    expect(out).toEqual({ type: "return", value: null });
  });

  it("converts a void terminal", () => {
    const out = terminalToOutput(makeTerminal({ kind: "void" }));
    expect(out).toEqual({ type: "void" });
  });
});

describe("effectToIR", () => {
  it("converts a mutation effect", () => {
    const effect: RawEffect = {
      type: "mutation",
      target: "users",
      operation: "update",
    };
    expect(effectToIR(effect)).toEqual({
      type: "mutation",
      target: "users",
      operation: "update",
    });
  });

  it("converts an invocation effect, seeding an empty args list", () => {
    const effect: RawEffect = {
      type: "invocation",
      callee: "sendEmail",
      async: true,
    };
    expect(effectToIR(effect)).toEqual({
      type: "invocation",
      callee: "sendEmail",
      args: [],
      async: true,
    });
  });

  it("converts an emission effect", () => {
    const effect: RawEffect = { type: "emission", event: "user.created" };
    expect(effectToIR(effect)).toEqual({
      type: "emission",
      event: "user.created",
    });
  });

  it("converts a stateChange effect", () => {
    const effect: RawEffect = { type: "stateChange", variable: "isLoading" };
    expect(effectToIR(effect)).toEqual({
      type: "stateChange",
      variable: "isLoading",
    });
  });
});

describe("paramToInput", () => {
  it("converts a typed parameter to an Input with a ref shape", () => {
    const param: RawParameter = {
      name: "req",
      position: 0,
      role: "request",
      typeText: "Request",
    };
    expect(paramToInput(param)).toEqual({
      type: "parameter",
      name: "req",
      position: 0,
      role: "request",
      shape: { type: "ref", name: "Request" },
    });
  });

  it("converts an untyped parameter to an Input with a null shape", () => {
    const param: RawParameter = {
      name: "opts",
      position: 2,
      role: "options",
      typeText: null,
    };
    expect(paramToInput(param)).toEqual({
      type: "parameter",
      name: "opts",
      position: 2,
      role: "options",
      shape: null,
    });
  });
});

describe("assessConfidence", () => {
  const baseRaw: RawCodeStructure = {
    ...twoPathRaw,
    branches: [],
  };

  it("returns 'high' when there are no conditions at all", () => {
    expect(assessConfidence(baseRaw)).toEqual({
      source: "inferred_static",
      level: "high",
    });
  });

  it("returns 'medium' when fewer than half of conditions are opaque", () => {
    const raw: RawCodeStructure = {
      ...baseRaw,
      branches: [
        {
          conditions: [
            {
              sourceText: "a",
              structured: {
                type: "truthinessCheck",
                subject: { type: "input", inputRef: "a", path: [] },
                negated: false,
              },
              polarity: "positive",
              source: "explicit",
            },
            {
              sourceText: "b",
              structured: {
                type: "truthinessCheck",
                subject: { type: "input", inputRef: "b", path: [] },
                negated: false,
              },
              polarity: "positive",
              source: "explicit",
            },
            {
              sourceText: "complex()",
              structured: {
                type: "opaque",
                sourceText: "complex()",
                reason: "complexExpression",
              },
              polarity: "positive",
              source: "explicit",
            },
          ],
          terminal: makeTerminal({ kind: "void" }),
          effects: [],
          location: { start: 0, end: 0 },
          isDefault: false,
        },
      ],
    };
    expect(assessConfidence(raw).level).toBe("medium");
  });

  it("counts a null-structured condition as opaque", () => {
    const raw: RawCodeStructure = {
      ...baseRaw,
      branches: [
        {
          conditions: [
            {
              sourceText: "mystery()",
              structured: null,
              polarity: "positive",
              source: "explicit",
            },
          ],
          terminal: makeTerminal({ kind: "void" }),
          effects: [],
          location: { start: 0, end: 0 },
          isDefault: false,
        },
      ],
    };
    expect(assessConfidence(raw).level).toBe("low");
  });
});

describe("detectGaps", () => {
  it("returns no gaps when there is no declared contract", () => {
    const raw: RawCodeStructure = { ...twoPathRaw, declaredContract: null };
    const gaps = detectGaps(raw, [], { gapHandling: "permissive" });
    expect(gaps).toEqual([]);
  });

  it("ignores dynamic status codes when matching declared responses", () => {
    // Handler produces only a dynamic status code — none of the declared
    // statuses are 'produced', so every declared response is reported as a gap.
    const summary = assembleSummary(
      {
        ...twoPathRaw,
        branches: [
          {
            conditions: [],
            terminal: makeTerminal({
              kind: "response",
              statusCode: { type: "dynamic", sourceText: "code" },
            }),
            effects: [],
            location: { start: 0, end: 0 },
            isDefault: true,
          },
        ],
        declaredContract: {
          framework: "ts-rest",
          responses: [{ statusCode: 200 }, { statusCode: 404 }],
        },
      },
      { gapHandling: "strict" },
    );
    // Both declared statuses become "never produced" gaps.
    const unproduced = summary.gaps.filter((g) =>
      g.description.includes("never produced"),
    );
    expect(unproduced).toHaveLength(2);
  });

  it("detects multiple concurrent gaps (declared 200,404,500 but only produces 200)", () => {
    const raw: RawCodeStructure = {
      ...twoPathRaw,
      branches: [
        {
          conditions: [],
          terminal: makeTerminal({
            kind: "response",
            statusCode: { type: "literal", value: 200 },
          }),
          effects: [],
          location: { start: 0, end: 0 },
          isDefault: true,
        },
      ],
      declaredContract: {
        framework: "ts-rest",
        responses: [
          { statusCode: 200 },
          { statusCode: 404 },
          { statusCode: 500 },
        ],
      },
    };
    const summary = assembleSummary(raw, { gapHandling: "strict" });
    const unproduced = summary.gaps.filter((g) =>
      g.description.includes("never produced"),
    );
    expect(unproduced).toHaveLength(2);
    const descriptions = unproduced.map((g) => g.description).join(", ");
    expect(descriptions).toContain("404");
    expect(descriptions).toContain("500");
  });

  it("detects both undeclared-production AND unproduced-declaration simultaneously", () => {
    // Declares 200, 500. Produces 200, 404.
    // → 500 never produced, 404 not declared.
    const raw: RawCodeStructure = {
      ...twoPathRaw, // produces 404 and 200
      declaredContract: {
        framework: "ts-rest",
        responses: [{ statusCode: 200 }, { statusCode: 500 }],
      },
    };
    const summary = assembleSummary(raw, { gapHandling: "strict" });
    expect(summary.gaps).toHaveLength(2);
    expect(
      summary.gaps.some(
        (g) =>
          g.description.includes("500") &&
          g.description.includes("never produced"),
      ),
    ).toBe(true);
    expect(
      summary.gaps.some(
        (g) =>
          g.description.includes("404") &&
          g.description.includes("not declared"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multi-condition branch assembly
// ---------------------------------------------------------------------------

describe("assembleSummary — multi-condition branches", () => {
  it("assembles a branch with 3+ conditions correctly", () => {
    const raw: RawCodeStructure = {
      ...twoPathRaw,
      branches: [
        {
          conditions: [
            {
              sourceText: "!id",
              structured: {
                type: "truthinessCheck",
                subject: { type: "input", inputRef: "id", path: [] },
                negated: true,
              },
              polarity: "negative",
              source: "earlyReturn",
            },
            {
              sourceText: "!user",
              structured: {
                type: "truthinessCheck",
                subject: {
                  type: "dependency",
                  name: "db.findById",
                  accessChain: [],
                },
                negated: true,
              },
              polarity: "negative",
              source: "earlyThrow",
            },
            {
              sourceText: "user.role === 'admin'",
              structured: {
                type: "comparison",
                left: {
                  type: "derived",
                  from: {
                    type: "dependency",
                    name: "db.findById",
                    accessChain: [],
                  },
                  derivation: { type: "propertyAccess", property: "role" },
                },
                op: "eq",
                right: { type: "literal", value: "admin" },
              },
              polarity: "positive",
              source: "explicit",
            },
          ],
          terminal: makeTerminal({
            kind: "response",
            statusCode: { type: "literal", value: 200 },
          }),
          effects: [],
          location: { start: 10, end: 15 },
          isDefault: false,
        },
      ],
    };
    const summary = assembleSummary(raw);
    const t = summary.transitions[0];
    expect(t.conditions).toHaveLength(3);
    // earlyReturn: negative polarity → negation wrapper
    expect(t.conditions[0].type).toBe("negation");
    // earlyThrow: negative polarity → negation wrapper
    expect(t.conditions[1].type).toBe("negation");
    // explicit: positive polarity → unwrapped comparison
    expect(t.conditions[2].type).toBe("comparison");
  });

  it("handles negative polarity with structured predicate (not just null)", () => {
    const raw: RawCodeStructure = {
      ...twoPathRaw,
      branches: [
        {
          conditions: [
            {
              sourceText: "user.active",
              structured: {
                type: "truthinessCheck",
                subject: {
                  type: "derived",
                  from: { type: "input", inputRef: "user", path: [] },
                  derivation: { type: "propertyAccess", property: "active" },
                },
                negated: false,
              },
              polarity: "negative",
              source: "explicit",
            },
          ],
          terminal: makeTerminal({
            kind: "response",
            statusCode: { type: "literal", value: 403 },
          }),
          effects: [],
          location: { start: 5, end: 8 },
          isDefault: false,
        },
      ],
    };
    const summary = assembleSummary(raw);
    const t = summary.transitions[0];
    // Negative polarity wraps the structured predicate in negation
    expect(t.conditions[0].type).toBe("negation");
    if (t.conditions[0].type === "negation") {
      expect(t.conditions[0].operand.type).toBe("truthinessCheck");
    }
  });

  it("preserves compound predicates through assembly", () => {
    const raw: RawCodeStructure = {
      ...twoPathRaw,
      branches: [
        {
          conditions: [
            {
              sourceText: "a && b",
              structured: {
                type: "compound",
                op: "and",
                operands: [
                  {
                    type: "truthinessCheck",
                    subject: { type: "input", inputRef: "a", path: [] },
                    negated: false,
                  },
                  {
                    type: "truthinessCheck",
                    subject: { type: "input", inputRef: "b", path: [] },
                    negated: false,
                  },
                ],
              },
              polarity: "positive",
              source: "explicit",
            },
          ],
          terminal: makeTerminal({
            kind: "response",
            statusCode: { type: "literal", value: 200 },
          }),
          effects: [],
          location: { start: 0, end: 0 },
          isDefault: false,
        },
      ],
    };
    const summary = assembleSummary(raw);
    expect(summary.transitions[0].conditions[0].type).toBe("compound");
  });
});

// ---------------------------------------------------------------------------
// Confidence scoring edge cases
// ---------------------------------------------------------------------------

describe("assessConfidence — boundary cases", () => {
  const baseRaw: RawCodeStructure = {
    ...twoPathRaw,
    branches: [],
  };

  it("returns 'low' at exactly 50% opaque (boundary)", () => {
    const raw: RawCodeStructure = {
      ...baseRaw,
      branches: [
        {
          conditions: [
            {
              sourceText: "a",
              structured: {
                type: "truthinessCheck",
                subject: { type: "input", inputRef: "a", path: [] },
                negated: false,
              },
              polarity: "positive",
              source: "explicit",
            },
            {
              sourceText: "complex()",
              structured: {
                type: "opaque",
                sourceText: "complex()",
                reason: "complexExpression",
              },
              polarity: "positive",
              source: "explicit",
            },
          ],
          terminal: makeTerminal({ kind: "void" }),
          effects: [],
          location: { start: 0, end: 0 },
          isDefault: false,
        },
      ],
    };
    // ratio = 1/2 = 0.5, which is >= 0.5, so "low"
    expect(assessConfidence(raw).level).toBe("low");
  });

  it("returns 'medium' at just under 50% opaque", () => {
    const raw: RawCodeStructure = {
      ...baseRaw,
      branches: [
        {
          conditions: [
            {
              sourceText: "a",
              structured: {
                type: "truthinessCheck",
                subject: { type: "input", inputRef: "a", path: [] },
                negated: false,
              },
              polarity: "positive",
              source: "explicit",
            },
            {
              sourceText: "b",
              structured: {
                type: "truthinessCheck",
                subject: { type: "input", inputRef: "b", path: [] },
                negated: false,
              },
              polarity: "positive",
              source: "explicit",
            },
          ],
          terminal: makeTerminal({ kind: "void" }),
          effects: [],
          location: { start: 0, end: 0 },
          isDefault: false,
        },
        {
          conditions: [
            {
              sourceText: "opaque()",
              structured: null,
              polarity: "positive",
              source: "explicit",
            },
          ],
          terminal: makeTerminal({ kind: "void" }),
          effects: [],
          location: { start: 0, end: 0 },
          isDefault: false,
        },
      ],
    };
    // 3 total conditions, 1 opaque → ratio = 1/3 ≈ 0.33 < 0.5 → "medium"
    expect(assessConfidence(raw).level).toBe("medium");
  });

  it("returns 'high' when all conditions are structured (zero opaque)", () => {
    const raw: RawCodeStructure = {
      ...baseRaw,
      branches: [
        {
          conditions: [
            {
              sourceText: "x > 0",
              structured: {
                type: "comparison",
                left: { type: "input", inputRef: "x", path: [] },
                op: "gt",
                right: { type: "literal", value: 0 },
              },
              polarity: "positive",
              source: "explicit",
            },
          ],
          terminal: makeTerminal({ kind: "void" }),
          effects: [],
          location: { start: 0, end: 0 },
          isDefault: false,
        },
      ],
    };
    expect(assessConfidence(raw).level).toBe("high");
  });
});
