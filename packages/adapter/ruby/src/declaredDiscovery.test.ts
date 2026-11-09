import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { imported } from "@suss/recognize";

import { declaredDiscoveryUnits } from "./declaredDiscovery.js";
import { parseRuby } from "./parser.js";
import { extractRubyProject } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { RubyPack } from "./pack.js";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "suss-rb-declared-")),
);

function write(rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.writeFileSync(abs, content);
  return abs;
}

/** Inline rather than a shipped pack, which depends on this package. */
const pack: RubyPack = {
  name: "declared-inline-test-pack",
  protocol: "in-process",
  discovery: [],
  declaredDiscovery: [
    {
      kind: "handler",
      match: {
        type: "manifest",
        entries: (file) =>
          path.basename(file) === "app.rb"
            ? [
                {
                  path: ["handler"],
                  units: [{ kind: "handler", name: "App.handler" }],
                },
                {
                  path: ["Reports", "Nightly"],
                  member: { name: "run", singleton: true },
                  units: [
                    {
                      kind: "worker",
                      name: "App.Reports::Nightly.run",
                      deployableUnit: {
                        deploymentTarget: "lambda",
                        instanceName: "App",
                      },
                      metadata: { declaredTest: true },
                    },
                  ],
                },
                {
                  path: ["Billing", "Handler"],
                  member: { name: "process", singleton: true },
                  units: [{ kind: "handler", name: "App.Billing.process" }],
                },
              ]
            : [],
      },
    },
    {
      kind: "consumer",
      match: {
        type: "registeredFunction",
        start: imported({ from: ["Jobs"], named: ["*"] }),
        method: "on",
        handler: { at: 1 },
      },
    },
  ],
};

let summaries: BehavioralSummary[] = [];

beforeAll(async () => {
  const files = [
    write(
      "app.rb",
      [
        "def handler(event:, context:)",
        "  helper(event)",
        "end",
        "",
        "def helper(event)",
        "  event",
        "end",
        "",
        "module Billing",
        "  class Handler",
        "  end",
        "end",
        "",
        "class Billing::Handler",
        "  def self.process(event:, context:)",
        "    event",
        "  end",
        "end",
        "",
        "module Reports",
        "  class Nightly",
        "    def self.run(event:, context:)",
        "      event",
        "    end",
        "  end",
        "end",
        "",
        'Jobs.on("orders", ->(batch) { batch })',
        "",
        "def later",
        '  Jobs.on("later", ->(batch) { batch })',
        "end",
        "",
        'Jobs.each { Jobs.on("block", ->(batch) { batch }) }',
        "",
      ].join("\n"),
    ),
  ];
  ({ summaries } = await extractRubyProject({
    files,
    packs: [pack],
    workspaceRoot: root,
    cacheDir: null,
  }));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a declared discovery pattern in Ruby", () => {
  it("builds a unit on the method a manifest spells, a class method through the module it is nested in", () => {
    const declared = summaries
      .filter(
        (summary) =>
          summary.identity.boundaryBinding?.recognition ===
          "declared-inline-test-pack",
      )
      .map(
        (summary) =>
          `${summary.kind} ${summary.identity.name} ${summary.identity.exportPath?.join(" ")}`,
      )
      .sort();

    expect(declared).toContain("handler App.handler handler");
    expect(declared).toContain(
      "worker App.Reports::Nightly.run Reports::Nightly run",
    );
    expect(declared).toContain(
      "handler App.Billing.process Billing::Handler process",
    );
  });

  it("starts the reach walk at the unit, so the helper it calls gets a summary", () => {
    expect(summaries.map((s) => s.identity.name)).toContain("helper");
  });

  it("finds nothing in a file built without the run's facts", async () => {
    const tree = await parseRuby("def handler(event:, context:)\nend\n");
    expect(
      declaredDiscoveryUnits(tree.rootNode, path.join(root, "app.rb"), {
        packs: [pack],
        displayPathOf: (file) => file,
        onReachSeed: () => undefined,
        tallies: new Map(),
      }),
    ).toEqual([]);
  });
});
