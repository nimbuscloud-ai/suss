/**
 * A pack hook that throws costs what that hook would have found, and the
 * failure goes on the pack's tally, so the rest of the run still
 * extracts and pack health does not read the pack as one that found
 * nothing. `discoveryInputs` runs only when the run caches, and a run
 * from source declines to cache, so `./version.js` is mocked here to let
 * a cache directory through.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./version.js")>();
  return {
    ...actual,
    adapterStamp: {
      ...actual.adapterStamp,
      declineWhenRunFromSource: (cacheDir: string | null) => cacheDir,
    },
  };
});

import { functionCallBinding } from "@suss/behavioral-ir";

import { extractPythonProject } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { ExtractionReport, PackFailure } from "@suss/extractor";
import type { PythonPack } from "./pack.js";

let root: string;
let appFile: string;
let helpersFile: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-py-pack-hooks-")),
  );
  appFile = path.join(root, "app.py");
  helpersFile = path.join(root, "helpers.py");
  fs.writeFileSync(appFile, "def handler(event, context):\n    return None\n");
  fs.writeFileSync(helpersFile, "def table_name():\n    return 'orders'\n");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A pack whose only hook is the one given, which throws. */
function breaking(hook: Partial<PythonPack>): PythonPack {
  return { name: "breaks", protocol: "http", discovery: [], ...hook };
}

function thrower(message: string): () => never {
  return () => {
    throw new Error(message);
  };
}

const ENTRY_PACK: PythonPack = {
  name: "entries",
  protocol: "http",
  discovery: [],
  entryPoints: (file) =>
    file === appFile
      ? [
          {
            name: "handler",
            units: [
              {
                kind: "handler",
                name: "Orders.handler",
                binding: functionCallBinding({
                  transport: "in-process",
                  recognition: "entries",
                }),
                deployableUnit: {
                  deploymentTarget: "lambda",
                  instanceName: "Orders",
                },
              },
            ],
          },
        ]
      : [],
};

async function run(
  packs: PythonPack[],
  cacheDir: string | null = null,
): Promise<{ summaries: BehavioralSummary[]; report: ExtractionReport }> {
  const reports: ExtractionReport[] = [];
  const noise = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const { summaries } = await extractPythonProject({
      files: [appFile, helpersFile],
      packs,
      roots: [root],
      projectRoot: root,
      cacheDir,
      onExtractionReport: (report) => reports.push(report),
    });
    const report = reports[0];
    if (report === undefined) {
      throw new Error("the run reported nothing");
    }
    return { summaries, report };
  } finally {
    noise.mockRestore();
  }
}

function failuresOf(report: ExtractionReport, pack: string): PackFailure[] {
  return report.packs.find((funnel) => funnel.pack === pack)?.failures ?? [];
}

const names = (summaries: readonly BehavioralSummary[]): string[] =>
  summaries.map((summary) => summary.identity.name);

describe("a Python pack hook that throws", () => {
  it("costs the units entryPoints would have given in each file, and the other pack's units stay", async () => {
    const { summaries, report } = await run([
      breaking({ entryPoints: thrower("cannot read the manifest") }),
      ENTRY_PACK,
    ]);

    expect(names(summaries)).toContain("Orders.handler");
    expect(failuresOf(report, "breaks")).toEqual([
      {
        hook: "entryPoints",
        file: appFile,
        message: "cannot read the manifest",
      },
      {
        hook: "entryPoints",
        file: helpersFile,
        message: "cannot read the manifest",
      },
    ]);
    expect(failuresOf(report, "entries")).toEqual([]);
  });

  it("keeps caching when discoveryInputs throws, and counts the failure once in each run", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-py-hooks-"));
    try {
      const packs = [
        breaking({ discoveryInputs: thrower("cannot list the templates") }),
        ENTRY_PACK,
      ];
      const failure: PackFailure = {
        hook: "discoveryInputs",
        file: root,
        message: "cannot list the templates",
      };

      const first = await run(packs, cacheDir);
      expect(names(first.summaries)).toContain("Orders.handler");
      expect(failuresOf(first.report, "breaks")).toEqual([failure]);

      // An edit misses the cache, so the next run tries again from the
      // failure the key recorded.
      fs.appendFileSync(helpersFile, "\n");
      const second = await run(packs, cacheDir);
      expect(names(second.summaries)).toContain("Orders.handler");
      expect(failuresOf(second.report, "breaks")).toEqual([failure]);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
