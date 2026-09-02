import { describe, expect, it } from "vitest";

import { runtimeConfigBinding } from "@suss/ir-core";

import { placeRuntimes } from "./placement.js";
import {
  contestedFiles,
  readCodeScope,
  runsIn,
  unitsByFile,
} from "./unitScope.js";

import type { BehavioralSummary, DeployableUnit } from "../index.js";
import type { UnitScope } from "./unitScope.js";

const lambda = (instanceName: string): DeployableUnit => ({
  deploymentTarget: "lambda",
  instanceName,
});

function code(file: string, unit?: string): BehavioralSummary {
  return {
    kind: "handler",
    location: { file, range: { start: 1, end: 4 }, exportName: "handler" },
    identity: {
      name: "handler",
      exportPath: ["handler"],
      boundaryBinding: null,
      ...(unit === undefined ? {} : { deployableUnit: lambda(unit) }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

/** A code summary that says which files its module imports. */
function importing(file: string, imports: string[]): BehavioralSummary {
  return { ...code(file), metadata: { moduleImports: imports } };
}

function runtime(opts: {
  name: string;
  scope?: string;
  entry?: string;
}): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "template.yaml",
      range: { start: 1, end: 5 },
      exportName: null,
    },
    identity: {
      name: opts.name,
      exportPath: null,
      boundaryBinding: runtimeConfigBinding({
        recognition: "cloudformation",
        deploymentTarget: "lambda",
        instanceName: opts.name,
      }),
      deployableUnit: lambda(opts.name),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      runtimeContract: { envVars: [] },
      codeScope:
        opts.scope === undefined
          ? { kind: "unknown" as const }
          : {
              kind: "codeUri" as const,
              path: opts.scope,
              ...(opts.entry === undefined ? {} : { entry: opts.entry }),
            },
    },
  };
}

const scopeOf = (path: string, unit?: string): UnitScope => ({
  unit: unit === undefined ? undefined : lambda(unit),
  codeScope: path,
});

describe("readCodeScope", () => {
  it("says unknown for a summary with no code scope on it", () => {
    expect(readCodeScope(code("src/a.ts"))).toEqual({ kind: "unknown" });
  });

  it("gives back the scope a runtime declares", () => {
    expect(readCodeScope(runtime({ name: "Api", scope: "src/api" }))).toEqual({
      kind: "codeUri",
      path: "src/api",
    });
  });
});

describe("unitsByFile", () => {
  it("keeps every unit a file's summaries mention", () => {
    const byFile = unitsByFile([
      code("src/handlers.ts", "Reader"),
      code("src/handlers.ts", "Writer"),
      code("src/helper.ts"),
    ]);

    expect(byFile.get("src/handlers.ts")).toEqual([
      lambda("Reader"),
      lambda("Writer"),
    ]);
    expect(byFile.has("src/helper.ts")).toBe(false);
  });

  it("records one unit once, however many summaries say it", () => {
    const byFile = unitsByFile([
      code("src/handlers.ts", "Reader"),
      code("src/handlers.ts", "Reader"),
    ]);

    expect(byFile.get("src/handlers.ts")).toEqual([lambda("Reader")]);
  });
});

describe("runsIn", () => {
  const byFile = unitsByFile([code("src/api/handler.ts", "Api")]);

  it("lets the two units decide when both sides give one", () => {
    expect(
      runsIn(code("src/api/handler.ts", "Api"), scopeOf("x", "Api"), byFile),
    ).toBe(true);
    expect(
      runsIn(code("src/api/handler.ts", "Api"), scopeOf("x", "Worker"), byFile),
    ).toBe(false);
  });

  it("reads a file's unit off the summaries beside it", () => {
    // The helper says no unit of its own; the handler in the same file
    // does, and a module is deployed whole.
    expect(
      runsIn(code("src/api/handler.ts"), scopeOf("x", "Api"), byFile),
    ).toBe(true);
  });

  it("lets the closure decide when the scope has one", () => {
    const scope: UnitScope = {
      unit: undefined,
      codeScope: "src/api",
      closure: new Set(["src/shared/log.ts"]),
    };

    expect(runsIn(code("src/shared/log.ts"), scope, new Map())).toBe(true);
    expect(runsIn(code("src/api/other.ts"), scope, new Map())).toBe(false);
  });

  it("falls back to the directory when nothing else says", () => {
    expect(
      runsIn(code("src/api/other.ts"), scopeOf("src/api"), new Map()),
    ).toBe(true);
    expect(
      runsIn(code("src/worker/other.ts"), scopeOf("src/api"), new Map()),
    ).toBe(false);
  });
});

describe("contestedFiles", () => {
  const shared = code("services/shared.ts");

  it("keeps a file two directories both contain", () => {
    const contested = contestedFiles(
      [shared],
      [scopeOf("services"), scopeOf("services")],
      new Map(),
    );

    expect([...contested]).toEqual(["services/shared.ts"]);
  });

  it("leaves a file only one directory contains", () => {
    const contested = contestedFiles(
      [shared],
      [scopeOf("services"), scopeOf("other")],
      new Map(),
    );

    expect([...contested]).toEqual([]);
  });

  it("leaves a file its own summaries place", () => {
    const placed = code("services/shared.ts", "Api");
    const contested = contestedFiles(
      [placed],
      [scopeOf("services"), scopeOf("services")],
      unitsByFile([placed]),
    );

    expect([...contested]).toEqual([]);
  });

  it("leaves a file a closure claims, since that settles it", () => {
    const withClosure: UnitScope = {
      unit: undefined,
      codeScope: "services",
      closure: new Set(["services/shared.ts"]),
    };
    const contested = contestedFiles(
      [shared],
      [withClosure, scopeOf("services")],
      new Map(),
    );

    expect([...contested]).toEqual([]);
  });

  it("counts only the scopes with no closure of their own", () => {
    // Two directories contain the file and one of them has a closure
    // that does not, so one directory is left and nothing is in doubt.
    const elsewhere: UnitScope = {
      unit: undefined,
      codeScope: "services",
      closure: new Set(["services/other.ts"]),
    };
    const contested = contestedFiles(
      [shared],
      [elsewhere, scopeOf("services")],
      new Map(),
    );

    expect([...contested]).toEqual([]);
  });
});

describe("placeRuntimes", () => {
  it("gives a runtime the closure its handler entry reaches", () => {
    const { placed } = placeRuntimes([
      runtime({ name: "Api", scope: "src/api", entry: "src/api/index" }),
      importing("src/api/index.ts", ["src/shared/log.ts"]),
      importing("src/shared/log.ts", []),
    ]);

    expect(placed).toHaveLength(1);
    expect([...(placed[0]?.scope.closure ?? [])].sort()).toEqual([
      "src/api/index.ts",
      "src/shared/log.ts",
    ]);
  });

  it("leaves the closure off when no file matches the entry", () => {
    const { placed } = placeRuntimes([
      runtime({ name: "Api", scope: "src/api", entry: "src/api/missing" }),
      importing("src/api/index.ts", []),
    ]);

    expect(placed[0]?.scope.closure).toBeUndefined();
    expect(placed[0]?.scope.codeScope).toBe("src/api");
  });

  it("reports a runtime that never said where its code is", () => {
    const { placed, unplaced } = placeRuntimes([runtime({ name: "Api" })]);

    expect(placed).toEqual([]);
    expect(unplaced.map((one) => one.runtime.identity.name)).toEqual(["Api"]);
  });
});
