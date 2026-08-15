// pythonJudge.test.ts: the adjudication semantics, held on hand-built
// inputs. The rules under test are the protocol's: a claim the app
// contradicts is falseClaim, behavior nothing claims or abstains over
// is uncovered, an abstention is never penalized, and a generator's
// own inconsistency surfaces as harnessFailure rather than a finding.

import { describe, expect, it } from "vitest";

import { restBinding } from "@suss/behavioral-ir";

import { judgePythonProgram } from "./pythonJudge.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { ObservedEndpoint } from "./pythonObserve.js";
import type { PyRouteIntent } from "./pythonProgram.js";

function summaryOf(options: {
  name: string;
  method: string | null;
  path: string | null;
  status?: number;
}): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "app_0/main.py",
      range: { start: 0, end: 1 },
      exportName: null,
    },
    identity: {
      name: options.name,
      exportPath: [options.name],
      boundaryBinding: restBinding({
        transport: "http",
        method: options.method,
        path: options.path,
        recognition: "fastapi",
      }),
    },
    inputs: [],
    transitions:
      options.status !== undefined
        ? [
            {
              id: "t1",
              conditions: [],
              output: {
                type: "response",
                statusCode: { type: "literal", value: options.status },
                body: null,
                headers: {},
              },
              isDefault: true,
            },
          ]
        : [],
    gaps: [],
    confidence: { source: "inferred_static", level: "low" },
  } as unknown as BehavioralSummary;
}

function intentOf(options: {
  name: string;
  method?: PyRouteIntent["method"];
  servedPaths: string[];
  expectation: PyRouteIntent["expectation"];
}): PyRouteIntent {
  return {
    name: options.name,
    method: options.method ?? "GET",
    servedPaths: options.servedPaths,
    expectation: options.expectation,
    requestBody: null,
  };
}

const served = (
  path: string,
  unit: string,
  status = 200,
  method = "GET",
): ObservedEndpoint => ({ path, method, unit, status });

describe("judgePythonProgram", () => {
  it("stays silent when every claim matches what the app serves", () => {
    const judgment = judgePythonProgram({
      intents: [
        intentOf({ name: "get_a", servedPaths: ["/a"], expectation: "claim" }),
      ],
      summaries: [summaryOf({ name: "get_a", method: "GET", path: "/a" })],
      endpoints: [served("/a", "get_a")],
      observationError: null,
    });
    expect(judgment.findings).toEqual([]);
    expect(judgment.claimedIntents).toBe(1);
    expect(judgment.abstainedIntents).toBe(0);
  });

  it("flags a claimed route the app does not serve as falseClaim", () => {
    const judgment = judgePythonProgram({
      intents: [
        intentOf({
          name: "get_a",
          servedPaths: ["/v1/a"],
          expectation: "abstain",
        }),
      ],
      summaries: [summaryOf({ name: "get_a", method: "GET", path: "/a" })],
      endpoints: [served("/v1/a", "get_a")],
      observationError: null,
    });
    expect(judgment.findings.map((f) => f.verdict)).toContain("falseClaim");
  });

  it("flags a declared status the probe contradicts as falseClaim", () => {
    const judgment = judgePythonProgram({
      intents: [
        intentOf({ name: "get_a", servedPaths: ["/a"], expectation: "claim" }),
      ],
      summaries: [
        summaryOf({ name: "get_a", method: "GET", path: "/a", status: 200 }),
      ],
      endpoints: [served("/a", "get_a", 418)],
      observationError: null,
    });
    expect(judgment.findings).toHaveLength(1);
    expect(judgment.findings[0].verdict).toBe("falseClaim");
    expect(judgment.findings[0].detail).toContain("418");
  });

  it("never penalizes a pathless summary over a route the generator expects abstention on", () => {
    const judgment = judgePythonProgram({
      intents: [
        intentOf({
          name: "get_a",
          servedPaths: ["/m/a"],
          expectation: "abstain",
        }),
      ],
      summaries: [summaryOf({ name: "get_a", method: "GET", path: null })],
      endpoints: [served("/m/a", "get_a")],
      observationError: null,
    });
    expect(judgment.findings).toEqual([]);
    expect(judgment.abstainedIntents).toBe(1);
  });

  it("flags an abstention where the generator expected a claim, so a quieter reading fails", () => {
    const judgment = judgePythonProgram({
      intents: [
        intentOf({
          name: "get_a",
          servedPaths: ["/m/a"],
          expectation: "claim",
        }),
      ],
      summaries: [summaryOf({ name: "get_a", method: "GET", path: null })],
      endpoints: [served("/m/a", "get_a")],
      observationError: null,
    });
    expect(judgment.findings.map((f) => f.verdict)).toEqual(["missingClaim"]);
    expect(judgment.findings[0].detail).toContain("get_a");
  });

  it("accepts a silently dropped route only when the generated shape is a documented abstention", () => {
    const dropped = judgePythonProgram({
      intents: [
        intentOf({
          name: "A.get",
          servedPaths: ["/b/a"],
          expectation: "abstain",
        }),
      ],
      summaries: [],
      endpoints: [served("/b/a", "A.get")],
      observationError: null,
    });
    expect(dropped.findings).toEqual([]);

    const missed = judgePythonProgram({
      intents: [
        intentOf({ name: "A.get", servedPaths: ["/a"], expectation: "claim" }),
      ],
      summaries: [],
      endpoints: [served("/a", "A.get")],
      observationError: null,
    });
    expect(missed.findings.map((f) => f.verdict)).toEqual([
      "uncovered",
      "missingClaim",
    ]);
  });

  it("reports a served route no intent names as harnessFailure, not a finding", () => {
    const judgment = judgePythonProgram({
      intents: [],
      summaries: [],
      endpoints: [served("/ghost", "ghost")],
      observationError: null,
    });
    expect(judgment.findings.map((f) => f.verdict)).toEqual(["harnessFailure"]);
  });

  it("reports a generated route the app never served as harnessFailure", () => {
    const judgment = judgePythonProgram({
      intents: [
        intentOf({ name: "get_a", servedPaths: ["/a"], expectation: "claim" }),
      ],
      summaries: [summaryOf({ name: "get_a", method: "GET", path: "/a" })],
      endpoints: [],
      observationError: null,
    });
    expect(judgment.findings.every((f) => f.verdict !== "uncovered")).toBe(
      true,
    );
    expect(judgment.findings.map((f) => f.verdict)).toContain("harnessFailure");
  });

  it("turns an observer error into one harnessFailure and no verdicts", () => {
    const judgment = judgePythonProgram({
      intents: [
        intentOf({ name: "get_a", servedPaths: ["/a"], expectation: "claim" }),
      ],
      summaries: [],
      endpoints: [],
      observationError: "Traceback: boom",
    });
    expect(judgment.findings.map((f) => f.verdict)).toEqual(["harnessFailure"]);
  });

  it("counts abstentions from the intent side, covering both pathless summaries and dropped units", () => {
    const judgment = judgePythonProgram({
      intents: [
        intentOf({ name: "get_a", servedPaths: ["/a"], expectation: "claim" }),
        intentOf({
          name: "get_b",
          servedPaths: ["/x/b"],
          expectation: "abstain",
        }),
        intentOf({
          name: "C.get",
          servedPaths: ["/y/c"],
          expectation: "abstain",
        }),
      ],
      summaries: [
        summaryOf({ name: "get_a", method: "GET", path: "/a" }),
        summaryOf({ name: "get_b", method: "GET", path: null }),
      ],
      endpoints: [
        served("/a", "get_a"),
        served("/x/b", "get_b"),
        served("/y/c", "C.get"),
      ],
      observationError: null,
    });
    expect(judgment.findings).toEqual([]);
    expect(judgment.intentsTotal).toBe(3);
    expect(judgment.claimedIntents).toBe(1);
    expect(judgment.abstainedIntents).toBe(2);
  });
});
