import { describe, expect, it } from "vitest";

import {
  disambiguateSummaryIds,
  fileReference,
  referencedFile,
  referencedFileKey,
} from "./summaryId.js";

import type { BehavioralSummary } from "./index.js";

/** A summary with this id that starts on this line, with a character span unless `span` is false. */
function summaryAt(
  id: string | undefined,
  line: number,
  span = true,
): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "src/a.ts",
      range: { start: line, end: line + 4 },
      ...(span ? { span: { start: line * 10, end: line * 10 + 40 } } : {}),
      exportName: "read",
    },
    identity: {
      ...(id === undefined ? {} : { id }),
      name: "read",
      exportPath: ["read"],
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function idsOf(summaries: BehavioralSummary[]): Array<string | undefined> {
  return summaries.map((summary) => summary.identity.id);
}

describe("settling ids that more than one summary has", () => {
  it("numbers them by where each starts in the file, so moving them keeps the ids", () => {
    const idsAt = (lines: number[]) => {
      const summaries = lines.map((line) =>
        summaryAt("svc::src/a.ts::read", line),
      );
      disambiguateSummaryIds(summaries);
      return idsOf(summaries);
    };

    expect(idsAt([40, 10])).toEqual([
      "svc::src/a.ts::read@2",
      "svc::src/a.ts::read",
    ]);
    expect(idsAt([50, 20])).toEqual(idsAt([40, 10]));
  });

  it("orders by line when a summary has no character span", () => {
    const summaries = [
      summaryAt("svc::src/a.ts::read", 30, false),
      summaryAt("svc::src/a.ts::read", 5, false),
    ];
    disambiguateSummaryIds(summaries);
    expect(idsOf(summaries)).toEqual([
      "svc::src/a.ts::read@2",
      "svc::src/a.ts::read",
    ]);
  });

  it("leaves a summary with no id without one", () => {
    const summaries = [summaryAt(undefined, 1), summaryAt(undefined, 9)];
    disambiguateSummaryIds(summaries);
    expect(idsOf(summaries)).toEqual([undefined, undefined]);
  });

  it("leaves a summary with no id without one when its boundary has a key", () => {
    const summaries = [clientAt("/a", 1), clientAt("/b", 9)];
    for (const summary of summaries) {
      delete summary.identity.id;
    }
    disambiguateSummaryIds(summaries);
    expect(idsOf(summaries)).toEqual([undefined, undefined]);
  });
});

/** A function a route calls, whose boundary has no key. */
function helperAt(line: number): BehavioralSummary {
  const summary = summaryAt("svc::src/a.ts::read", line);
  summary.identity.boundaryBinding = {
    transport: "in-process",
    semantics: { name: "function-call" },
    recognition: "reachable",
  };
  return summary;
}

/** A client of `GET path`, which keys its boundary. */
function clientAt(path: string, line: number): BehavioralSummary {
  const summary = summaryAt("svc::src/a.ts::read", line);
  summary.identity.boundaryBinding = {
    transport: "http",
    semantics: { name: "rest", method: "GET", path },
    recognition: "fetch",
  };
  return summary;
}

describe("settling an id whose boundary has no key", () => {
  it("numbers two that share an id by their order in the file", () => {
    const summaries = [helperAt(40), helperAt(10)];
    disambiguateSummaryIds(summaries);
    expect(idsOf(summaries)).toEqual([
      "svc::src/a.ts::read@2",
      "svc::src/a.ts::read",
    ]);
  });

  it("extends only the one with a key when the other has none", () => {
    const summaries = [helperAt(10), clientAt("/a", 30)];
    disambiguateSummaryIds(summaries);
    expect(idsOf(summaries)).toEqual([
      "svc::src/a.ts::read",
      "svc::src/a.ts::read#GET /a",
    ]);
  });

  it("keeps its id when a keyed summary with the same id is added", () => {
    const alone = [helperAt(10)];
    const withAnother = [helperAt(10), clientAt("/a", 30)];
    disambiguateSummaryIds(alone);
    disambiguateSummaryIds(withAnother);
    expect(withAnother[0]?.identity.id).toBe(alone[0]?.identity.id);
  });

  it("is numbered with a summary that has no boundary at all, by their order in the file", () => {
    const summaries = [summaryAt("svc::src/a.ts::read", 30), helperAt(10)];
    disambiguateSummaryIds(summaries);
    expect(idsOf(summaries)).toEqual([
      "svc::src/a.ts::read@2",
      "svc::src/a.ts::read",
    ]);
  });
});

describe("the id of a summary named by a label", () => {
  /** An Express handler, which discovery names after its method. */
  function route(path: string, line: number): BehavioralSummary {
    const summary = summaryAt("svc::src/a.ts::get", line);
    summary.identity.name = "get";
    summary.identity.nameKind = "label";
    summary.identity.boundaryBinding = {
      transport: "http",
      semantics: { name: "rest", method: "GET", path },
      recognition: "express",
    };
    return summary;
  }

  it("has its route even when nothing else in the file is named the same", () => {
    const summaries = [route("/a", 5)];
    disambiguateSummaryIds(summaries);
    expect(idsOf(summaries)).toEqual(["svc::src/a.ts::get#GET /a"]);
  });

  it("stays the same when a second route is added to the file", () => {
    const alone = [route("/a", 5)];
    const withAnother = [route("/a", 5), route("/b", 20)];
    disambiguateSummaryIds(alone);
    disambiguateSummaryIds(withAnother);
    expect(withAnother[0]?.identity.id).toBe(alone[0]?.identity.id);
  });

  it("is numbered by file order when two share a route", () => {
    const summaries = [route("/a", 20), route("/a", 5)];
    disambiguateSummaryIds(summaries);
    expect(idsOf(summaries)).toEqual([
      "svc::src/a.ts::get#GET /a@2",
      "svc::src/a.ts::get#GET /a",
    ]);
  });

  /** A timer claimed inside the handler at `line`, which is internal code with no key. */
  function timerIn(line: number): BehavioralSummary {
    const summary = summaryAt("svc::src/a.ts::get.setTimeout#0", line + 1);
    summary.identity.name = "get.setTimeout#0";
    summary.identity.nameKind = "label";
    summary.location.range = { start: line + 1, end: line + 2 };
    summary.location.span = { start: line * 10 + 5, end: line * 10 + 20 };
    summary.identity.boundaryBinding = {
      transport: "in-process",
      semantics: { name: "function-call" },
      recognition: "reachable",
    };
    return summary;
  }

  it("gives a claim in each of two routes its own handler's route", () => {
    const summaries = [
      route("/a", 5),
      timerIn(5),
      route("/b", 20),
      timerIn(20),
    ];
    disambiguateSummaryIds(summaries);
    expect(idsOf(summaries)).toEqual([
      "svc::src/a.ts::get#GET /a",
      "svc::src/a.ts::get.setTimeout#0#GET /a",
      "svc::src/a.ts::get#GET /b",
      "svc::src/a.ts::get.setTimeout#0#GET /b",
    ]);
  });

  it("keeps a claim's id when a route is added above its handler", () => {
    const alone = [route("/b", 20), timerIn(20)];
    const withAnother = [
      route("/a", 5),
      timerIn(5),
      route("/b", 20),
      timerIn(20),
    ];
    disambiguateSummaryIds(alone);
    disambiguateSummaryIds(withAnother);
    expect(withAnother[3]?.identity.id).toBe(alone[1]?.identity.id);
  });

  it("finds the handler by line when the summaries have no character span", () => {
    const summaries = [route("/a", 5), timerIn(5)];
    for (const summary of summaries) {
      delete summary.location.span;
    }
    disambiguateSummaryIds(summaries);
    expect(summaries[1]?.identity.id).toBe(
      "svc::src/a.ts::get.setTimeout#0#GET /a",
    );
  });

  it("takes the boundary of the innermost labelled summary the claim is named after", () => {
    const outer = route("/a", 5);
    outer.location.span = { start: 0, end: 500 };
    const inner = route("/a/inner", 6);
    inner.identity.name = "get.inner";
    inner.identity.id = "svc::src/a.ts::get.inner";
    inner.location.span = { start: 60, end: 200 };
    const timer = timerIn(6);
    timer.identity.name = "get.inner.setTimeout#0";
    timer.identity.id = "svc::src/a.ts::get.inner.setTimeout#0";
    timer.location.span = { start: 70, end: 90 };
    const summaries = [outer, inner, timer];
    disambiguateSummaryIds(summaries);
    expect(timer.identity.id).toBe(
      "svc::src/a.ts::get.inner.setTimeout#0#GET /a/inner",
    );
  });

  it("takes its handler's route when it shares its id with a claim that has no route to take", () => {
    const summaries = [route("/a", 5), timerIn(5), timerIn(60)];
    disambiguateSummaryIds(summaries);
    expect(idsOf(summaries)).toEqual([
      "svc::src/a.ts::get#GET /a",
      "svc::src/a.ts::get.setTimeout#0#GET /a",
      "svc::src/a.ts::get.setTimeout#0",
    ]);
  });

  it("numbers two claims with no route to take by their order in the file", () => {
    const summaries = [timerIn(60), timerIn(40)];
    disambiguateSummaryIds(summaries);
    expect(idsOf(summaries)).toEqual([
      "svc::src/a.ts::get.setTimeout#0@2",
      "svc::src/a.ts::get.setTimeout#0",
    ]);
  });

  it("leaves a keyless label alone when no labelled summary around it has its name in front", () => {
    const timer = timerIn(5);
    timer.identity.name = "post.setTimeout#0";
    timer.identity.id = "svc::src/a.ts::post.setTimeout#0";
    const summaries = [route("/a", 5), timer];
    disambiguateSummaryIds(summaries);
    expect(timer.identity.id).toBe("svc::src/a.ts::post.setTimeout#0");
  });
});

describe("a path one summary records for another file", () => {
  it("puts the other project's name in front, and reads it back", () => {
    const written = fileReference("@acme/shared", "src/routes.ts");

    expect(written).toBe("@acme/shared::src/routes.ts");
    expect(referencedFile("@acme/api", written)).toEqual({
      workspace: "@acme/shared",
      file: "src/routes.ts",
    });
  });

  it("reads a plain path as a file in the recording summary's own project", () => {
    expect(referencedFile("@acme/api", "src/a.ts")).toEqual({
      workspace: "@acme/api",
      file: "src/a.ts",
    });
    expect(referencedFileKey("@acme/api", "src/a.ts")).toBe(
      "@acme/api::src/a.ts",
    );
  });

  it("writes a path in a project with no name plain, so it keys as itself", () => {
    expect(fileReference(undefined, "src/a.ts")).toBe("src/a.ts");
    expect(fileReference("", "src/a.ts")).toBe("src/a.ts");
    expect(referencedFileKey(undefined, "src/a.ts")).toBe("src/a.ts");
    expect(referencedFile(undefined, "::src/a.ts")).toEqual({
      workspace: undefined,
      file: "src/a.ts",
    });
  });
});
