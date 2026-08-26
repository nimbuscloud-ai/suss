import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { restBinding } from "@suss/behavioral-ir";

import { inspectDiff } from "./inspect.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/** The smallest summary a diff has something to say about. */
function routeSummary(name: string, routePath: string): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: `src/handlers/${name}.ts`,
      range: { start: 1, end: 50 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: restBinding({
        transport: "http",
        recognition: "test",
        method: "GET",
        path: routePath,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

/** What a call wrote to stdout, and what it returned. */
function captureStdout<T>(run: () => T): { output: string; result: T } {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: run(), output: written.join("") };
  } finally {
    process.stdout.write = original;
  }
}

describe("inspect --diff --json", () => {
  const withFiles = (
    before: BehavioralSummary[],
    after: BehavioralSummary[],
    run: (paths: { before: string; after: string }) => void,
  ) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-diffjson-"));
    const beforePath = path.join(dir, "before.json");
    const afterPath = path.join(dir, "after.json");
    fs.writeFileSync(beforePath, JSON.stringify(before));
    fs.writeFileSync(afterPath, JSON.stringify(after));
    try {
      run({ before: beforePath, after: afterPath });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("says which summaries were removed", () => {
    // The summaries a diff reads are already JSON, and the diff itself
    // is worked out from two of them, so a machine has nowhere else to
    // get it.
    withFiles([routeSummary("getUser", "/users/:id")], [], (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, json: true }),
      );
      const parsed = JSON.parse(output) as {
        version: number;
        changed: number;
        summaries: Array<{ change: string; kind: string }>;
      };

      expect(parsed.version).toBe(1);
      expect(parsed.changed).toBe(1);
      expect(parsed.summaries[0]?.change).toBe("removed");
      expect(parsed.summaries[0]?.kind).toBe("handler");
    });
  });

  it("says which were added", () => {
    withFiles([], [routeSummary("getUser", "/users/:id")], (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, json: true }),
      );
      const parsed = JSON.parse(output) as {
        summaries: Array<{ change: string }>;
      };
      expect(parsed.summaries[0]?.change).toBe("added");
    });
  });

  it("leaves out a summary that did not move", () => {
    // A consumer wants what changed. Printing every unchanged boundary
    // beside it buries that.
    const same = [routeSummary("getUser", "/users/:id")];
    withFiles(same, same, (paths) => {
      const { output } = captureStdout(() =>
        inspectDiff({ ...paths, json: true }),
      );
      const parsed = JSON.parse(output) as { changed: number };
      expect(parsed.changed).toBe(0);
    });
  });

  it("prints for a person when nobody asked for JSON", () => {
    withFiles([routeSummary("getUser", "/users/:id")], [], (paths) => {
      const { output } = captureStdout(() => inspectDiff(paths));
      expect(output).toContain("removed handler");
      expect(() => JSON.parse(output)).toThrow();
    });
  });
});
