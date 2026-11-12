import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { imported } from "@suss/recognize";

import { declaredDiscoveryUnits } from "./declaredDiscovery.js";
import { parsePython } from "./parser.js";
import { extractPythonProject, factsForFile } from "./project.js";
import { bindModule } from "./scope.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PythonPack } from "./pack.js";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "suss-py-declared-")),
);

function write(rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.writeFileSync(abs, content);
  return abs;
}

/** Inline rather than a shipped pack, which depends on this package. */
const pack: PythonPack = {
  name: "declared-inline-test-pack",
  protocol: "in-process",
  discovery: [],
  declaredDiscovery: [
    {
      kind: "handler",
      match: {
        type: "manifest",
        entries: (file) =>
          path.basename(file) === "app.py"
            ? ["handler", "aliased", "imported_one"].map((name) => ({
                path: [name],
                units: [
                  {
                    kind: "handler",
                    name: `App.${name}`,
                    invocationInfo: {
                      deploymentTarget: "lambda",
                      instanceName: "App",
                    },
                    deployableUnit: {
                      deploymentTarget: "lambda",
                      instanceName: "App",
                    },
                    metadata: { declaredTest: { name } },
                  },
                ],
              }))
            : [],
      },
    },
    {
      kind: "consumer",
      match: {
        type: "registeredFunction",
        start: imported({ from: ["jobs"], named: ["queue"] }),
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
      "app.py",
      [
        "from jobs import queue",
        "from helpers import imported_one",
        "",
        "def handler(event, context):",
        "    return event",
        "",
        "def real(event, context):",
        "    return event",
        "",
        "aliased = real",
        "",
        "def drain(batch):",
        "    return batch",
        "",
        'queue.on("orders", drain)',
        "",
        "def later():",
        '    queue.on("later", real)',
        "",
        'skipped = lambda: queue.on("lambda", real)',
        "",
      ].join("\n"),
    ),
    write(
      "helpers.py",
      "def imported_one(event, context):\n    return event\n",
    ),
  ];
  ({ summaries } = await extractPythonProject({
    files,
    packs: [pack],
    roots: [root],
    workspaceRoot: root,
    cacheDir: null,
  }));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function declared(): string[] {
  return summaries
    .filter(
      (summary) =>
        summary.identity.boundaryBinding?.recognition ===
        "declared-inline-test-pack",
    )
    .map(
      (summary) =>
        `${summary.kind} ${summary.identity.name} ${summary.identity.exportPath?.join(".")}`,
    )
    .sort();
}

describe("a declared discovery pattern in Python", () => {
  it("builds a unit on the def a manifest spells, through a name bound to it, and none on an imported name", () => {
    expect(declared()).toEqual([
      "consumer drain drain",
      "handler App.aliased aliased",
      "handler App.handler handler",
    ]);
  });

  it("puts the deployable unit and the pack's metadata on the summary", () => {
    const handler = summaries.find((s) => s.identity.name === "App.handler");
    expect(handler?.identity.deployableUnit).toEqual({
      deploymentTarget: "lambda",
      instanceName: "App",
    });
    expect(handler?.metadata?.declaredTest).toEqual({ name: "handler" });
  });

  it("states which parameter the platform fills before it reads the unit", async () => {
    const file = path.join(root, "worker.py");
    const tree = await parsePython(
      'def serve(request, env):\n    return env.GREETING\n\n\ndefault = {"fetch": serve}\n',
    );
    const module = bindModule(tree.rootNode);
    const facts = factsForFile({
      file,
      root: tree.rootNode,
      module,
      packs: [],
    });
    const handing: PythonPack = {
      name: "handed-in-test-pack",
      protocol: "in-process",
      discovery: [],
      declaredDiscovery: [
        {
          kind: "handler",
          match: {
            type: "namedExport",
            names: ["default"],
            members: {
              named: {
                fetch: {
                  kind: "handler",
                  name: "fetch",
                  handedIn: [{ at: 1, name: "env" }],
                },
              },
            },
          },
        },
      ],
    };
    const units = declaredDiscoveryUnits(
      { file, displayPath: file, root: tree.rootNode, module },
      [handing],
      { facts, storageFor: () => undefined, tallies: new Map() },
    );
    expect(units.map((unit) => unit.identity.name)).toEqual(["fetch"]);
    expect(
      facts
        .facts("handedIn")
        .map(([parameter, name]) => [
          String(parameter).split("#").at(-1),
          name,
        ]),
    ).toEqual([["env", "env"]]);
  });
});
