import { describe, expect, it } from "vitest";

import { stampModuleImports } from "./moduleImports.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function summaryIn(file: string): BehavioralSummary {
  return {
    location: { file },
    metadata: { kept: true },
  } as unknown as BehavioralSummary;
}

describe("stampModuleImports", () => {
  it("writes each file's imports sorted and deduplicated, keeping the rest of the metadata", () => {
    const summary = summaryIn("src/a.py");
    stampModuleImports([summary], () => ["src/z.py", "src/b.py", "src/z.py"]);
    expect(summary.metadata).toEqual({
      kept: true,
      moduleImports: ["src/b.py", "src/z.py"],
    });
  });

  it("stamps an empty list, which makes the file a leaf of the graph", () => {
    const summary = summaryIn("src/worker.py");
    stampModuleImports([summary], () => []);
    expect(summary.metadata?.moduleImports).toEqual([]);
  });

  it("leaves a summary alone when the lookup has nothing to say", () => {
    const summary = summaryIn("src/a.ts");
    stampModuleImports([summary], () => undefined);
    expect(summary.metadata?.moduleImports).toBeUndefined();
  });

  it("asks about each file once and gives every summary in it the same answer", () => {
    const asked: string[] = [];
    const first = summaryIn("src/a.py");
    const second = summaryIn("src/a.py");
    stampModuleImports([first, second], (file) => {
      asked.push(file);
      return ["src/b.py"];
    });
    expect(asked).toEqual(["src/a.py"]);
    expect(second.metadata?.moduleImports).toEqual(["src/b.py"]);
  });
});
