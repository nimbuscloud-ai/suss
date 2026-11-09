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

import { railsTestPack } from "./__fixtures__/railsControllerPattern.js";
import { extractRubyProject } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type {
  DeclaredDiscoveryPattern,
  ExtractionReport,
  ManifestEntry,
  PackFailure,
} from "@suss/extractor";
import type { RubyPack } from "./pack.js";

let root: string;
let handlerFile: string;
let controllerFile: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-rb-pack-hooks-")),
  );
  handlerFile = path.join(root, "handler.rb");
  fs.writeFileSync(handlerFile, "def handler(event:, context:)\n  nil\nend\n");
  controllerFile = path.join(root, "app/controllers/orders_controller.rb");
  fs.mkdirSync(path.dirname(controllerFile), { recursive: true });
  fs.writeFileSync(
    controllerFile,
    [
      "class ApplicationController",
      "  def health",
      "  end",
      "end",
      "",
      "class OrdersController < ApplicationController",
      "  def index",
      "  end",
      "end",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A pack whose only hook is the one given, which throws. */
function breaking(hook: Partial<RubyPack>): RubyPack {
  return { name: "breaks", protocol: "http", discovery: [], ...hook };
}

function thrower(message: string): () => never {
  return () => {
    throw new Error(message);
  };
}

const ENTRY_PACK: RubyPack = {
  name: "entries",
  protocol: "http",
  discovery: [],
  declaredDiscovery: [
    manifest((file) =>
      file === handlerFile
        ? [
            {
              path: ["handler"],
              units: [
                {
                  kind: "handler",
                  name: "Fn.handler",
                  invocationInfo: {
                    deploymentTarget: "lambda",
                    instanceName: "Fn",
                  },
                  deployableUnit: {
                    deploymentTarget: "lambda",
                    instanceName: "Fn",
                  },
                },
              ],
            },
          ]
        : [],
    ),
  ],
};

function manifest(
  entries: (file: string) => ManifestEntry[],
): DeclaredDiscoveryPattern {
  return { kind: "handler", match: { type: "manifest", entries } };
}

async function run(
  packs: RubyPack[],
  cacheDir: string | null = null,
): Promise<{ summaries: BehavioralSummary[]; report: ExtractionReport }> {
  const reports: ExtractionReport[] = [];
  const noise = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const { summaries } = await extractRubyProject({
      files: [handlerFile, controllerFile],
      packs,
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

describe("a Ruby pack hook that throws", () => {
  it("costs the units a declared discovery pattern would have given in each file, and the other pack's units stay", async () => {
    const { summaries, report } = await run([
      breaking({
        declaredDiscovery: [manifest(thrower("cannot read the manifest"))],
      }),
      ENTRY_PACK,
    ]);

    expect(names(summaries)).toContain("Fn.handler");
    expect(failuresOf(report, "breaks")).toEqual([
      {
        hook: "discovery",
        file: handlerFile,
        message: "cannot read the manifest",
      },
      {
        hook: "discovery",
        file: controllerFile,
        message: "cannot read the manifest",
      },
    ]);
    expect(failuresOf(report, "entries")).toEqual([]);
  });

  it("adds no boot template when bootTemplates throws, and reports the run's root", async () => {
    const { summaries, report } = await run([
      breaking({ bootTemplates: thrower("cannot find the config") }),
      ENTRY_PACK,
    ]);

    expect(names(summaries)).toContain("Fn.handler");
    expect(failuresOf(report, "breaks")).toEqual([
      {
        hook: "bootTemplates",
        file: root,
        message: "cannot find the config",
      },
    ]);
  });

  it("leaves an action with no route when routesFor throws, at both places it is asked", async () => {
    const { summaries, report } = await run([
      railsTestPack({
        root: path.dirname(controllerFile),
        routesFor: (_controller, action) => {
          throw new Error(`cannot route ${action}`);
        },
      }),
    ]);

    expect(names(summaries)).toContain("index");
    // An inherited action is served only when it has a route, so `health`
    // is asked about first and left out.
    expect(failuresOf(report, "rails")).toEqual([
      {
        hook: "routesFor",
        file: controllerFile,
        message: "cannot route health",
      },
      {
        hook: "routesFor",
        file: controllerFile,
        message: "cannot route index",
      },
    ]);
  });

  it("reports no routing gap when routingGaps throws, against the routes file", async () => {
    const { summaries, report } = await run([
      railsTestPack({
        root: path.dirname(controllerFile),
        routesFile: path.join(root, "config/routes.rb"),
        routingGaps: thrower("cannot read the routes"),
      }),
    ]);

    expect(names(summaries)).toContain("index");
    expect(failuresOf(report, "rails")).toEqual([
      {
        hook: "routingGaps",
        file: path.join(root, "config/routes.rb"),
        message: "cannot read the routes",
      },
    ]);
  });

  it("keeps caching when discoveryInputs throws, and counts the failure once in each run", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rb-hooks-"));
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
      expect(names(first.summaries)).toContain("Fn.handler");
      expect(failuresOf(first.report, "breaks")).toEqual([failure]);

      // An edit misses the cache, so the next run tries again from the
      // failure the key recorded.
      fs.appendFileSync(handlerFile, "\n");
      const second = await run(packs, cacheDir);
      expect(names(second.summaries)).toContain("Fn.handler");
      expect(failuresOf(second.report, "breaks")).toEqual([failure]);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
