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
