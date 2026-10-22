import { describe, expect, it } from "vitest";

import { runtimeConfigBinding } from "@suss/ir-core";

import { buildModuleGraph } from "./entryClosure.js";
import { placeDeclared, placeRuntimes } from "./placement.js";
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

/** What a Terraform configuration states: a handler and no directory. */
function handlerOnly(name: string, entry: string): BehavioralSummary {
  const declared = runtime({ name });
  return {
    ...declared,
    metadata: { ...declared.metadata, codeScope: { kind: "unknown", entry } },
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

  it("tells a sibling package's file from the run's own file at the same path", () => {
    const inProject = (workspace: string, file: string): BehavioralSummary => {
      const one = code(file);
      return { ...one, location: { ...one.location, workspace } };
    };
    const scope: UnitScope = {
      unit: undefined,
      closure: new Set(["@acme/shared::src/log.ts"]),
    };

    expect(
      runsIn(inProject("@acme/shared", "src/log.ts"), scope, new Map()),
    ).toBe(true);
    expect(runsIn(inProject("@acme/api", "src/log.ts"), scope, new Map())).toBe(
      false,
    );
  });

  it("falls back to the directory when nothing else says", () => {
    expect(
      runsIn(code("src/api/other.ts"), scopeOf("src/api"), new Map()),
    ).toBe(true);
    expect(
      runsIn(code("src/worker/other.ts"), scopeOf("src/api"), new Map()),
    ).toBe(false);
  });

  it("leaves a sibling package's file at the same path out of the template's directory", () => {
    const inProject = (workspace: string, file: string): BehavioralSummary => {
      const one = code(file);
      return { ...one, location: { ...one.location, workspace } };
    };
    const scope: UnitScope = { ...scopeOf("src"), workspace: "@acme/api" };

    expect(
      runsIn(inProject("@acme/api", "src/config.ts"), scope, new Map()),
    ).toBe(true);
    expect(
      runsIn(inProject("@acme/shared", "src/config.ts"), scope, new Map()),
    ).toBe(false);
    expect(runsIn(code("src/config.ts"), scope, new Map())).toBe(true);
    expect([
      ...contestedFiles(
        [inProject("@acme/shared", "src/config.ts")],
        [scope, { ...scopeOf("src"), workspace: "@acme/web" }],
        new Map(),
      ),
    ]).toEqual([]);
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

  it("places a runtime that states a handler entry and no directory", () => {
    const { placed } = placeRuntimes([
      handlerOnly("Confirm", "src/handlers/confirm"),
      importing("src/handlers/confirm.ts", ["src/shared/log.ts"]),
      importing("src/shared/log.ts", []),
    ]);

    expect([...(placed[0]?.scope.closure ?? [])].sort()).toEqual([
      "src/handlers/confirm.ts",
      "src/shared/log.ts",
    ]);
    expect(placed[0]?.scope.codeScope).toBeUndefined();
  });

  it("places a file by the closure alone when no directory was stated", () => {
    const { placed } = placeRuntimes([
      handlerOnly("Confirm", "src/handlers/confirm"),
      importing("src/handlers/confirm.ts", ["src/shared/log.ts"]),
      importing("src/shared/log.ts", []),
      importing("src/other/unrelated.ts", []),
    ]);
    const scope = placed[0]?.scope as UnitScope;
    const byFile = unitsByFile([]);

    expect(runsIn(code("src/shared/log.ts"), scope, byFile)).toBe(true);
    expect(runsIn(code("src/other/unrelated.ts"), scope, byFile)).toBe(false);
  });

  it("reports a runtime whose entry matches no module and states no directory", () => {
    const { placed, unplaced } = placeRuntimes([
      handlerOnly("Confirm", "dist/confirm"),
      importing("src/handlers/confirm.ts", []),
    ]);

    expect(placed).toEqual([]);
    expect(unplaced.map((one) => one.runtime.identity.name)).toEqual([
      "Confirm",
    ]);
  });
});

describe("placeDeclared", () => {
  it("places a queue consumer through the handler entry it states", () => {
    const declared = runtime({ name: "Worker", scope: "", entry: "src/work" });
    const consumer: BehavioralSummary = {
      ...declared,
      kind: "consumer",
      identity: { ...declared.identity, boundaryBinding: null },
    };
    const graph = buildModuleGraph([
      importing("src/work.ts", ["src/shared/log.ts"]),
      importing("src/shared/log.ts", []),
      importing("scripts/backfill.ts", []),
    ]);

    const scope = placeDeclared(consumer, graph);
    expect([...(scope?.closure ?? [])].sort()).toEqual([
      "src/shared/log.ts",
      "src/work.ts",
    ]);
    expect(scope?.unit).toEqual(lambda("Worker"));
  });

  it("enters through the file in the template's own project when a sibling package has one at the same path", () => {
    const declared = runtime({
      name: "Api",
      scope: "src",
      entry: "src/handler",
    });
    const metadata = declared.metadata as Record<
      string,
      Record<string, unknown>
    >;
    const api: BehavioralSummary = {
      ...declared,
      metadata: {
        ...metadata,
        codeScope: { ...metadata.codeScope, workspace: "@acme/api" },
      },
    };
    const inProject = (workspace: string, file: string, imports: string[]) => {
      const one = importing(file, imports);
      return { ...one, location: { ...one.location, workspace } };
    };
    const graph = buildModuleGraph([
      inProject("@acme/shared", "src/handler.ts", []),
      inProject("@acme/api", "src/handler.ts", ["src/db.ts"]),
      inProject("@acme/api", "src/db.ts", []),
    ]);

    const scope = placeDeclared(api, graph);
    expect([...(scope?.closure ?? [])].sort()).toEqual([
      "@acme/api::src/db.ts",
      "@acme/api::src/handler.ts",
    ]);
    expect(scope?.workspace).toBe("@acme/api");
  });
});
