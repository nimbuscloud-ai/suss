import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { restBinding } from "@suss/behavioral-ir";

import {
  buildExtractionReport,
  commonDirectoryOf,
  createPackTallies,
  unresolvedGatesFor,
} from "./diagnostics.js";

import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const gatedPack: PatternPack = {
  name: "gated",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: { type: "namedExport", names: ["handler"] },
      requiresImport: ["@scope/lib"],
    },
  ],
  terminals: [],
  inputMapping: { type: "positionalParams", params: [] },
};

const ungatedPack: PatternPack = {
  name: "ungated",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: { type: "namedExport", names: ["handler"] },
      requiresImport: [],
    },
  ],
  terminals: [],
  inputMapping: { type: "positionalParams", params: [] },
};

/**
 * A summary with only what the funnel reads off it: which pack
 * recognised it, and whether it says anything.
 */
function summaryFrom(
  pack: string,
  opts: {
    transitions?: number;
    gaps?: number;
    confidence?: "high" | "low";
  } = {},
): BehavioralSummary {
  return {
    kind: "handler",
    location: { file: "x.ts", range: { start: 0, end: 1 }, exportName: null },
    identity: {
      name: "handler",
      exportPath: null,
      boundaryBinding: restBinding({
        transport: "http",
        method: "GET",
        path: "/",
        recognition: pack,
      }),
    },
    inputs: [],
    transitions: Array.from(
      { length: opts.transitions ?? 1 },
      (_, i): Transition => ({
        id: `t${i}`,
        conditions: [],
        output: { type: "void" },
        effects: [],
        location: { start: 0, end: 1 },
        isDefault: true,
      }),
    ),
    gaps: Array.from({ length: opts.gaps ?? 0 }, () => ({
      type: "unreadOutcome" as const,
      conditions: [],
      consequence: "unknown" as const,
      description: "x",
    })),
    confidence: {
      source: "inferred_static" as const,
      level: opts.confidence ?? ("high" as const),
    },
  };
}

function report(
  packs: PatternPack[],
  counts: Record<
    string,
    {
      candidateFiles: number;
      unitsDiscovered: number;
      summariesProduced: number;
    }
  >,
  overrides: {
    filesInProject?: number | null;
    filesWalked?: number;
    projectRoot?: string;
  } = {},
) {
  const tallies = createPackTallies(packs);
  const summaries: BehavioralSummary[] = [];
  for (const [name, c] of Object.entries(counts)) {
    tallies.set(name, {
      ...c,
      unitsInGatedFiles: 0,
      effectsRecognized: 0,
      failures: [],
      helpersMatched: new Set<string>(),
      unitsClaimed: c.unitsDiscovered,
      selfCollisions: 0,
    });
    for (let i = 0; i < c.summariesProduced; i += 1) {
      summaries.push(summaryFrom(name));
    }
  }
  return buildExtractionReport({
    packs,
    tallies,
    filesInProject: overrides.filesInProject ?? 10,
    filesWalked: overrides.filesWalked ?? 5,
    summaries,
    tsConfigFilePath: undefined,
    projectRoot: overrides.projectRoot,
  });
}

/** A throwaway project, with or without `@scope/lib` installed in it. */
async function tempProject(withDependency: boolean): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "suss-diag-"));
  await fs.writeFile(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
      },
      include: ["**/*.ts"],
    }),
  );
  if (withDependency) {
    const pkgDir = path.join(dir, "node_modules", "@scope", "lib");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@scope/lib", types: "index.d.ts" }),
    );
    await fs.writeFile(
      path.join(pkgDir, "index.d.ts"),
      "export declare const x: number;",
    );
  }
  return path.join(dir, "tsconfig.json");
}

describe("buildExtractionReport", () => {
  it("reports no empty stage when the run produced summaries", () => {
    const r = report([gatedPack], {
      gated: { candidateFiles: 3, unitsDiscovered: 2, summariesProduced: 2 },
    });
    expect(r.emptyStage).toBeNull();
    expect(r.summaries).toBe(2);
  });

  it("blames the tsconfig when it matched no files", () => {
    const r = report(
      [gatedPack],
      {
        gated: { candidateFiles: 0, unitsDiscovered: 0, summariesProduced: 0 },
      },
      { filesInProject: 0, filesWalked: 0 },
    );
    expect(r.emptyStage).toBe("tsconfig");
  });

  it("blames the gate when no file matched it", () => {
    const r = report([gatedPack], {
      gated: { candidateFiles: 0, unitsDiscovered: 0, summariesProduced: 0 },
    });
    expect(r.emptyStage).toBe("candidateFiles");
  });

  // A missing dependency and a project that never wanted it look the
  // same from the gate alone, and blaming the gate for the second tells
  // someone to install a package they do not need. What separates them
  // is whether any file matched the gate, since the pre-filter matches
  // on import text and does not care whether the package is there.
  it("blames the gate when a file asked for a package that is missing", async () => {
    const root = path.dirname(await tempProject(false));
    const r = report(
      [gatedPack],
      {
        gated: { candidateFiles: 2, unitsDiscovered: 0, summariesProduced: 0 },
      },
      { projectRoot: root },
    );
    expect(r.packs[0]?.unresolvedGates).toEqual(["@scope/lib"]);
    expect(r.emptyStage).toBe("gateResolution");
  });

  it("blames the gate for nothing when no file asked for the package", async () => {
    const root = path.dirname(await tempProject(false));
    const r = report(
      [gatedPack],
      {
        gated: { candidateFiles: 0, unitsDiscovered: 0, summariesProduced: 0 },
      },
      { projectRoot: root },
    );
    expect(r.packs[0]?.unresolvedGates).toEqual(["@scope/lib"]);
    expect(r.emptyStage).toBe("candidateFiles");
  });

  it("blames discovery when candidates existed but no unit was found", () => {
    const r = report([gatedPack], {
      gated: { candidateFiles: 4, unitsDiscovered: 0, summariesProduced: 0 },
    });
    expect(r.emptyStage).toBe("discovery");
  });

  it("blames assembly when units were discovered but nothing was built", () => {
    const r = report([gatedPack], {
      gated: { candidateFiles: 4, unitsDiscovered: 3, summariesProduced: 0 },
    });
    expect(r.emptyStage).toBe("assembly");
  });

  it("records an ungated pack as having no gates", () => {
    const r = report([ungatedPack], {
      ungated: { candidateFiles: 5, unitsDiscovered: 1, summariesProduced: 1 },
    });
    expect(r.packs[0]?.gates).toEqual([]);
  });

  it("carries each pack's gate specifiers", () => {
    const r = report([gatedPack], {
      gated: { candidateFiles: 1, unitsDiscovered: 1, summariesProduced: 1 },
    });
    expect(r.packs[0]?.gates).toEqual(["@scope/lib"]);
  });
});

describe("unresolvedGatesFor", () => {
  const from = (tsConfigFilePath?: string, projectRoot?: string) =>
    unresolvedGatesFor(["@scope/lib"], { tsConfigFilePath, projectRoot });

  it("reports a gate that does not resolve", async () => {
    expect(from(await tempProject(false))).toEqual(["@scope/lib"]);
  });

  it("stays silent when the gate resolves", async () => {
    expect(from(await tempProject(true))).toEqual([]);
  });

  it("resolves from the project root when there is no tsconfig", async () => {
    const installed = path.dirname(await tempProject(true));
    const bare = path.dirname(await tempProject(false));
    expect(from(undefined, installed)).toEqual([]);
    expect(from(undefined, bare)).toEqual(["@scope/lib"]);
  });

  it("checks nothing with neither a tsconfig nor a root", () => {
    expect(from(undefined, undefined)).toEqual([]);
  });
});

describe("commonDirectoryOf", () => {
  it("gives the deepest directory holding every file", () => {
    expect(
      commonDirectoryOf(["/a/b/src/x.ts", "/a/b/src/nested/y.ts", "/a/b/z.ts"]),
    ).toBe("/a/b");
  });

  it("gives nothing when the paths share only the filesystem root", () => {
    expect(commonDirectoryOf(["/a/x.ts", "/b/y.ts"])).toBeUndefined();
  });

  it("ignores the in-memory paths a virtual project uses", () => {
    expect(commonDirectoryOf(["x.ts", "y.ts"])).toBeUndefined();
  });
});
