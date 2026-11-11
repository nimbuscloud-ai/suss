import { type Node, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { compile, handedIn, imported, runtimeReads } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "../adapter.js";
import { ResolutionStore } from "../facts/store.js";
import { moduleOpsFor } from "./declared.js";

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

  it("states no function of a file whose text never writes the directive", () => {
    const project = createTestProject();
    const store = new ResolutionStore();
    const plain = project.createSourceFile(
      "/plain.ts",
      "export function helper() { return () => 1; }",
    );
    expect(moduleOpsFor(plain, store).marked("use server")).toBe(false);
    expect(moduleOpsFor(plain, store).markedFunctions("use server")).toEqual(
      [],
    );
    expect(store.factAccess().db.size("func")).toBe(0);

    const marked = project.createSourceFile(
      "/marked.ts",
      'export function save() { "use server"; return 1; }',
    );
    expect(
      moduleOpsFor(marked, store)
        .markedFunctions("use server")
        .map((found) => found.assignedName),
    ).toEqual(["save"]);
    expect(store.factAccess().db.size("func")).toBeGreaterThan(0);
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

  it("states which parameter the platform fills on a unit it claims, so a read chain off it reads the body", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/worker.ts",
      [
        "interface Env { GREETING: string }",
        "export default {",
        "  fetch(request: unknown, settings: Env) { return settings.GREETING; },",
        "};",
      ].join("\n"),
    );
    const env = runtimeReads({ object: handedIn("env") }).entries(
      {},
      { reads: "config" },
    );
    const pack: PatternPack = {
      name: "declared",
      protocol: "in-process",
      languages: ["typescript"],
      discovery: [
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
      terminals: [
        { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      ],
      inputMapping: { type: "positionalParams", params: [] },
      accessRecognizers: [compile(env.declared, "declared")],
    };
    const [fetch] = await createTypeScriptAdapter({
      project,
      frameworks: [pack],
    }).extractAll();
    expect(
      fetch?.transitions
        .flatMap((transition) => transition.effects)
        .map((effect) => (effect.type === "interaction" ? effect.callee : "")),
    ).toEqual(["env.GREETING"]);
  });

  it("says a name refers to the parameter only inside the unit it was stated on", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/worker.ts",
      [
        "export default { fetch(request: unknown, env: { A: string }) { return env.A; } };",
        "export function other(request: unknown, env: { B: string }) { return env.B; }",
      ].join("\n"),
    );
    const store = new ResolutionStore();
    const reference = (text: string): Node => {
      const read = file
        .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
        .find((node) => node.getText() === text);
      if (read === undefined) {
        throw new Error(`no read ${text}`);
      }
      return read.getExpression();
    };
    expect(store.refersToHandedIn(reference("env.A"), "env")).toBe(false);

    const [fetch] = file.getDescendantsOfKind(SyntaxKind.MethodDeclaration);
    store.stateHandedIn(fetch as Node, [{ at: 1, name: "env" }]);
    expect([
      store.refersToHandedIn(reference("env.A"), "env"),
      store.refersToHandedIn(reference("env.B"), "env"),
      store.refersToHandedIn(reference("env.A"), "ctx"),
    ]).toEqual([true, false, false]);
  });

  it("follows the parameter into a local and into a helper it is passed to, whichever is asked first", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/worker.ts",
      [
        "function helper(settings: { H: string }) { return settings.H; }",
        "export default {",
        "  fetch(request: unknown, env: { H: string; L: string; O: string }) {",
        "    const scoped = env;",
        "    return scoped.L + helper(env);",
        "  },",
        "};",
        "export function other(request: unknown, env: { O: string }) { return env.O; }",
      ].join("\n"),
    );
    const reached = (store: ResolutionStore, entry: string): string[] => {
      const read = file
        .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
        .find((node) => node.getName() === entry);
      return read === undefined
        ? []
        : [...store.handedReaching(read.getExpression())];
    };
    const [fetch] = file.getDescendantsOfKind(SyntaxKind.MethodDeclaration);
    const orders = [
      ["O", "L", "H"],
      ["L", "H", "O"],
    ].map((order) => {
      const store = new ResolutionStore();
      expect(reached(store, "L")).toEqual([]);
      store.stateHandedIn(fetch as Node, [{ at: 1, name: "env" }]);
      return Object.fromEntries(
        order.map((entry) => [entry, reached(store, entry)]),
      );
    });
    for (const answers of orders) {
      expect(answers).toEqual({ O: [], L: ["env"], H: ["env"] });
    }
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
