/**
 * A pack whose `discoveryInputs` throws while the run builds its cache
 * key puts no file in the key, and the failure goes on its tally. The
 * hook runs only when the run caches, and a run from source declines to
 * cache, so `./version.js` is mocked here to let a cache directory
 * through.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("./version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./version.js")>()),
  declineWhenRunFromSource: (cacheDir: string | null) => cacheDir,
}));

import type { ExtractionReport, PatternPack } from "@suss/extractor";

/**
 * The adapter module loaded again, so it picks up the mock above. The
 * package's tests share one module registry, and a file that ran earlier
 * may already have loaded the adapter with the cache off.
 */
async function adapterModuleWithCacheOn(): Promise<
  typeof import("./adapter.js")
> {
  vi.resetModules();
  return await import("./adapter.js");
}

const HANDLERS: PatternPack = {
  name: "handlers",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    { kind: "handler", match: { type: "namedExport", names: ["handler"] } },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  ],
  inputMapping: { type: "positionalParams", params: [] },
};

const BREAKS: PatternPack = {
  ...HANDLERS,
  name: "breaks",
  discovery: [],
  discoveryInputs: () => {
    throw new Error("cannot list the templates");
  },
};

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-ts-inputs-")),
  );
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
  );
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "src/a.ts"),
    "export function handler(): number {\n  return 200;\n}\n",
  );
  return dir;
}

describe("a pack whose discoveryInputs throws", () => {
  it("keeps the run and its cache going, and goes on the pack's tally", async () => {
    const dir = makeProject();
    const { createTypeScriptAdapter } = await adapterModuleWithCacheOn();
    let report: ExtractionReport | null = null;
    const noise = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const summaries = await createTypeScriptAdapter({
        tsConfigFilePath: path.join(dir, "tsconfig.json"),
        projectRoot: dir,
        frameworks: [HANDLERS, BREAKS],
        cacheDir: path.join(dir, ".suss", "cache"),
        onExtractionReport: (r) => {
          report = r;
        },
      }).extractAll();

      expect(summaries.map((summary) => summary.identity.name)).toEqual([
        "handler",
      ]);
    } finally {
      noise.mockRestore();
    }

    expect(
      (report as ExtractionReport | null)?.packs.find(
        (funnel) => funnel.pack === "breaks",
      )?.failures,
    ).toEqual([
      {
        hook: "discoveryInputs",
        file: dir,
        message: "cannot list the templates",
      },
    ]);
  });
});
