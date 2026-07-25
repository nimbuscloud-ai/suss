import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildExtractionReport,
  createPackTallies,
  unresolvedGatesFor,
} from "./diagnostics.js";

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
  overrides: { filesInProject?: number | null; filesWalked?: number } = {},
) {
  const tallies = createPackTallies(packs);
  for (const [name, c] of Object.entries(counts)) {
    tallies.set(name, c);
  }
  return buildExtractionReport({
    packs,
    tallies,
    filesInProject: overrides.filesInProject ?? 10,
    filesWalked: overrides.filesWalked ?? 5,
    summaries: Object.values(counts).reduce(
      (sum, c) => sum + c.summariesProduced,
      0,
    ),
    tsConfigFilePath: undefined,
  });
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

  it("reports a gate that does not resolve", async () => {
    const tsconfig = await tempProject(false);
    expect(unresolvedGatesFor(["@scope/lib"], tsconfig)).toEqual([
      "@scope/lib",
    ]);
  });

  it("stays silent when the gate resolves", async () => {
    const tsconfig = await tempProject(true);
    expect(unresolvedGatesFor(["@scope/lib"], tsconfig)).toEqual([]);
  });

  it("checks nothing without a tsconfig path", () => {
    expect(unresolvedGatesFor(["@scope/lib"], undefined)).toEqual([]);
  });
});
