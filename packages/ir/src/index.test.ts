import { describe, expect, it } from "vitest";

import {
  type BehavioralSummary,
  diffSummaries,
  type Output,
  type Predicate,
  type Transition,
} from "./index.js";

function makeSummary(transitions: Transition[]): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "src/test.ts",
      range: { start: 1, end: 10 },
      exportName: "test",
    },
    identity: { name: "test", exportPath: ["test"], boundaryBinding: null },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function makeTransition(id: string, output: Output): Transition {
  return {
    id,
    conditions: [],
    output,
    effects: [],
    location: { start: 1, end: 5 },
    isDefault: false,
  };
}

describe("diffSummaries", () => {
  it("returns empty arrays for identical summaries", () => {
    const t = makeTransition("t1", {
      type: "response",
      statusCode: { type: "literal", value: 200 },
      body: null,
      headers: {},
    });
    const summary = makeSummary([t]);
    const diff = diffSummaries(summary, summary);
    expect(diff.addedTransitions).toHaveLength(0);
    expect(diff.removedTransitions).toHaveLength(0);
    expect(diff.changedTransitions).toHaveLength(0);
  });

  it("detects an added transition", () => {
    const t1 = makeTransition("t1", {
      type: "response",
      statusCode: { type: "literal", value: 200 },
      body: null,
      headers: {},
    });
    const t2 = makeTransition("t2", {
      type: "response",
      statusCode: { type: "literal", value: 404 },
      body: null,
      headers: {},
    });
    const before = makeSummary([t1]);
    const after = makeSummary([t1, t2]);
    const diff = diffSummaries(before, after);
    expect(diff.addedTransitions).toHaveLength(1);
    expect(diff.addedTransitions[0].id).toBe("t2");
    expect(diff.removedTransitions).toHaveLength(0);
    expect(diff.changedTransitions).toHaveLength(0);
  });

  it("detects a removed transition", () => {
    const t1 = makeTransition("t1", {
      type: "response",
      statusCode: { type: "literal", value: 200 },
      body: null,
      headers: {},
    });
    const t2 = makeTransition("t2", {
      type: "response",
      statusCode: { type: "literal", value: 404 },
      body: null,
      headers: {},
    });
    const before = makeSummary([t1, t2]);
    const after = makeSummary([t1]);
    const diff = diffSummaries(before, after);
    expect(diff.removedTransitions).toHaveLength(1);
    expect(diff.removedTransitions[0].id).toBe("t2");
    expect(diff.addedTransitions).toHaveLength(0);
    expect(diff.changedTransitions).toHaveLength(0);
  });

  it("detects a changed transition (same id, different output)", () => {
    const t1 = makeTransition("t1", {
      type: "response",
      statusCode: { type: "literal", value: 200 },
      body: null,
      headers: {},
    });
    const t1changed = makeTransition("t1", {
      type: "response",
      statusCode: { type: "literal", value: 201 },
      body: null,
      headers: {},
    });
    const before = makeSummary([t1]);
    const after = makeSummary([t1changed]);
    const diff = diffSummaries(before, after);
    expect(diff.changedTransitions).toHaveLength(1);
    expect(diff.changedTransitions[0].before.id).toBe("t1");
    expect(diff.changedTransitions[0].after.id).toBe("t1");
    expect(diff.addedTransitions).toHaveLength(0);
    expect(diff.removedTransitions).toHaveLength(0);
  });

  it("Predicate discriminated union narrows correctly", () => {
    const pred: Predicate = {
      type: "nullCheck",
      subject: { type: "unresolved", sourceText: "x" },
      negated: false,
    };
    if (pred.type === "nullCheck") {
      expect(pred.negated).toBe(false);
    } else {
      throw new Error("unexpected predicate type");
    }
  });

  it("Output discriminated union narrows correctly", () => {
    const output: Output = {
      type: "response",
      statusCode: { type: "literal", value: 200 },
      body: null,
      headers: {},
    };
    if (output.type === "response") {
      expect(output.statusCode).toBeDefined();
      expect(output.headers).toBeDefined();
    } else {
      throw new Error("unexpected output type");
    }
  });

  it("Output.response statusCode can be a dynamic ValueRef", () => {
    const output: Output = {
      type: "response",
      statusCode: { type: "unresolved", sourceText: "statusVar" },
      body: null,
      headers: {},
    };
    expect(output.type).toBe("response");
    if (output.type === "response") {
      expect(output.statusCode?.type).toBe("unresolved");
    }
  });
});
