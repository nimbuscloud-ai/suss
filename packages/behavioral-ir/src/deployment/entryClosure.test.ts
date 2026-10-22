import { describe, expect, it } from "vitest";

import {
  buildModuleGraph,
  entryClosure,
  type ModuleGraph,
} from "./entryClosure.js";

import type { BehavioralSummary } from "../index.js";

function moduleSummary(
  workspace: string,
  file: string,
  moduleImports: string[],
): BehavioralSummary {
  return {
    kind: "module-init",
    location: {
      file,
      range: { start: 1, end: 1 },
      exportName: null,
      workspace,
    },
    identity: { name: file, exportPath: null, boundaryBinding: null },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    metadata: { moduleImports },
  };
}

const graph: ModuleGraph = new Map([
  ["src/a.ts", ["src/shared.ts"]],
  ["src/shared.ts", ["src/deep.ts"]],
  ["src/deep.ts", []],
  ["src/b.ts", []],
]);

describe("entryClosure", () => {
  it("reaches transitively from the extensionless entry", () => {
    expect(entryClosure("src/a", graph)).toEqual(
      new Set(["src/a.ts", "src/shared.ts", "src/deep.ts"]),
    );
  });

  it("returns null when no file matches the entry", () => {
    expect(entryClosure("src/missing", graph)).toBeNull();
  });

  it("matches a Python module written with dots against a file path", () => {
    const python: ModuleGraph = new Map([
      ["src/shop/app.py", ["src/shop/settings.py"]],
      ["src/shop/settings.py", []],
      ["src/worker.py", []],
    ]);
    expect(entryClosure("src/shop.app", python)).toEqual(
      new Set(["src/shop/app.py", "src/shop/settings.py"]),
    );
    expect(entryClosure("src/worker", python)).toEqual(
      new Set(["src/worker.py"]),
    );
  });
});

describe("buildModuleGraph", () => {
  it("follows an import into a sibling package, and not into the run's own file of the same name", () => {
    const graph = buildModuleGraph([
      moduleSummary("@acme/api", "src/handler.ts", [
        "@acme/shared::src/config.ts",
      ]),
      moduleSummary("@acme/api", "src/config.ts", []),
      moduleSummary("@acme/shared", "src/config.ts", ["src/env.ts"]),
      moduleSummary("@acme/shared", "src/env.ts", []),
    ]);

    expect(entryClosure("src/handler", graph)).toEqual(
      new Set([
        "@acme/api::src/handler.ts",
        "@acme/shared::src/config.ts",
        "@acme/shared::src/env.ts",
      ]),
    );
  });
});
