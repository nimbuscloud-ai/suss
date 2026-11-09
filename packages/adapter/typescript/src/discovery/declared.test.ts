import { describe, expect, it } from "vitest";

import { imported } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "../adapter.js";

import type { DiscoveryPattern, PatternPack } from "@suss/extractor";

async function unitsFor(
  files: Record<string, string>,
  discovery: DiscoveryPattern[],
): Promise<string[]> {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/hooks/package.json",
    JSON.stringify({ name: "hooks", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/hooks/index.d.ts",
    "export declare const hooks: { register(name: string, run: unknown): void };",
  );
  for (const [name, source] of Object.entries(files)) {
    project.createSourceFile(name, source);
  }
  const pack: PatternPack = {
    name: "declared",
    protocol: "in-process",
    languages: ["typescript"],
    discovery,
    terminals: [
      {
        kind: "return",
        match: { type: "functionFallthrough" },
        extraction: {},
      },
    ],
    inputMapping: { type: "positionalParams", params: [] },
  };
  const summaries = await createTypeScriptAdapter({
    project,
    frameworks: [pack],
  }).extractAll();
  return summaries
    .filter(
      (summary) => summary.identity.boundaryBinding?.recognition === "declared",
    )
    .map((summary) => `${summary.kind} ${summary.identity.name}`)
    .sort();
}

describe("a declared discovery pattern", () => {
  it("takes the functions marked in place by the name they are declared or assigned under, or a count", async () => {
    expect(
      await unitsFor(
        {
          "/form.tsx": [
            'function declared() { "use server"; return 1; }',
            "class Store {",
            '  save() { "use server"; return 2; }',
            "}",
            "export const handlers = {",
            '  remove: async () => { "use server"; return 3; },',
            "};",
            'run(async function () { "use server"; return 4; });',
            "function run(action: unknown) { return action; }",
          ].join("\n"),
        },
        [
          {
            kind: "action",
            match: {
              type: "marked",
              word: "use server",
              scopes: ["function"],
              name: ["assignedName", "countInFile"],
              countedAs: "serverAction",
            },
          },
        ],
      ),
    ).toEqual([
      "action declared",
      "action remove",
      "action save",
      "action serverAction#0",
    ]);
  });

  it("reads a registration the module body runs, and none written inside a function", async () => {
    expect(
      await unitsFor(
        {
          "/boot.ts": [
            'import { hooks } from "hooks";',
            "function serve(request: unknown) { return request; }",
            'hooks.register("fetch", serve);',
            "export function later() {",
            '  hooks.register("fetch", () => 1);',
            "}",
            "new Map();",
          ].join("\n"),
        },
        [
          {
            kind: "handler",
            match: {
              type: "registeredFunction",
              start: imported({ from: ["hooks"], named: ["hooks"] }),
              method: "register",
              handler: { at: 1 },
            },
          },
        ],
      ),
    ).toEqual(["handler serve"]);
  });

  it("finds the export a manifest spells through a re-export", async () => {
    expect(
      await unitsFor(
        {
          "/impl.ts": "export function handler() { return 1; }",
          "/index.ts": 'export { handler } from "./impl";',
        },
        [
          {
            kind: "handler",
            match: {
              type: "manifest",
              entries: (file) =>
                file === "/index.ts"
                  ? [
                      {
                        path: ["handler"],
                        units: [{ kind: "handler", name: "Index.handler" }],
                      },
                    ]
                  : [],
            },
          },
        ],
      ),
    ).toEqual(["handler Index.handler"]);
  });
});
