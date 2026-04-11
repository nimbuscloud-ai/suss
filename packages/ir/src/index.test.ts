import { describe, it, expect } from "vitest";
import {
  diffSummaries,
  BehavioralSummary,
  Transition,
  Predicate,
  Output,
} from "./index.js";

function makeSummary(transitions: Transition[]): BehavioralSummary {
  return {
    kind: "handler",
    location: { file: "src/test.ts", range: { start: 1, end: 10 }, exportName: "test" },
    identity: { name: "test", exportPath: ["test"] },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "test", level: "high" },
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
    const t = makeTransition("t1", { type: "response", statusCode: 200, body: null });
    const summary = makeSummary([t]);
    const diff = diffSummaries(summary, summary);
    expect(diff.addedTransitions).toHaveLength(0);
    expect(diff.removedTransitions).toHaveLength(0);
    expect(diff.changedTransitions).toHaveLength(0);
  });

  it("detects an added transition", () => {
    const t1 = makeTransition("t1", { type: "response", statusCode: 200, body: null });
    const t2 = makeTransition("t2", { type: "response", statusCode: 404, body: null });
    const before = makeSummary([t1]);
    const after = makeSummary([t1, t2]);
    const diff = diffSummaries(before, after);
    expect(diff.addedTransitions).toHaveLength(1);
    expect(diff.addedTransitions[0].id).toBe("t2");
    expect(diff.removedTransitions).toHaveLength(0);
    expect(diff.changedTransitions).toHaveLength(0);
  });

  it("detects a removed transition", () => {
    const t1 = makeTransition("t1", { type: "response", statusCode: 200, body: null });
    const t2 = makeTransition("t2", { type: "response", statusCode: 404, body: null });
    const before = makeSummary([t1, t2]);
    const after = makeSummary([t1]);
    const diff = diffSummaries(before, after);
    expect(diff.removedTransitions).toHaveLength(1);
    expect(diff.removedTransitions[0].id).toBe("t2");
    expect(diff.addedTransitions).toHaveLength(0);
    expect(diff.changedTransitions).toHaveLength(0);
  });

  it("detects a changed transition (same id, different output)", () => {
    const t1 = makeTransition("t1", { type: "response", statusCode: 200, body: null });
    const t1changed = makeTransition("t1", { type: "response", statusCode: 201, body: null });
    const before = makeSummary([t1]);
    const after = makeSummary([t1changed]);
    const diff = diffSummaries(before, after);
    expect(diff.changedTransitions).toHaveLength(1);
    expect(diff.changedTransitions[0].before.id).toBe("t1");
    expect(diff.changedTransitions[0].after.id).toBe("t1");
    expect(diff.addedTransitions).toHaveLength(0);
    expect(diff.removedTransitions).toHaveLength(0);
  });

  it("discriminated union Predicate narrows correctly in switch", () => {
    const pred: Predicate = { type: "nullCheck", subject: { type: "unresolved", sourceText: "x" }, negated: false };
    switch (pred.type) {
      case "nullCheck":
        expect(pred.negated).toBe(false);
        break;
      case "truthinessCheck":
        expect(pred.negated).toBeDefined();
        break;
      default:
        // other variants
    }
  });

  it("discriminated union Output narrows correctly in switch", () => {
    const output: Output = { type: "response", statusCode: 200, body: { ok: true } };
    switch (output.type) {
      case "response":
        expect(output.statusCode).toBe(200);
        break;
      case "throw":
        expect(output.exceptionType).toBeDefined();
        break;
      default:
        // other variants
    }
  });
});
