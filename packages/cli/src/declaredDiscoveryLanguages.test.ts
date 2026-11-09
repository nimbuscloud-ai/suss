/**
 * The declared discovery members run over the same code written in
 * TypeScript, Python and Ruby. One reader in @suss/recognize asks each
 * adapter's module ops, so one declaration finds the same units in every
 * language that can write the construct. A member only TypeScript can
 * write (a directive, a JSX element) is tested in TypeScript alone, and
 * the test says why.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject } from "@suss/adapter-python";
import { extractRubyProject } from "@suss/adapter-ruby";
import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { imported } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type {
  DeclaredDiscoveryPattern,
  ManifestEntry,
  PatternPack,
  UnitSpec,
} from "@suss/extractor";

/** Every unit a run found, as `kind name binding`, sorted so the languages compare. */
function found(
  summaries: readonly BehavioralSummary[],
  pack: string,
): string[] {
  return summaries
    .filter((summary) => summary.identity.boundaryBinding?.recognition === pack)
    .map(
      (summary) =>
        `${summary.kind} ${summary.identity.name} ${summary.identity.boundaryBinding?.semantics.name}`,
    )
    .sort();
}

const TERMINALS: PatternPack["terminals"] = [
  { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  { kind: "return", match: { type: "functionFallthrough" }, extraction: {} },
];

/** A TypeScript pack with the patterns, the shape the CLI loads one in. */
function typescriptPack(patterns: DeclaredDiscoveryPattern[]): PatternPack {
  return {
    name: "declared-discovery",
    protocol: "in-process",
    languages: ["typescript"],
    discovery: patterns.map((pattern) => ({ ...pattern, requiresImport: [] })),
    terminals: TERMINALS,
    inputMapping: { type: "positionalParams", params: [] },
  };
}

/** The same patterns as a Python or Ruby pack lists them. */
function dataPack(patterns: DeclaredDiscoveryPattern[]) {
  return {
    name: "declared-discovery",
    protocol: "in-process",
    discovery: [],
    declaredDiscovery: patterns,
  };
}

async function typescriptUnits(
  files: Record<string, string>,
  patterns: DeclaredDiscoveryPattern[],
): Promise<string[]> {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/workers/package.json",
    JSON.stringify({ name: "workers", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/workers/index.d.ts",
    [
      "export declare class WorkerEntrypoint { fetch(request: unknown): unknown; }",
      "export declare const hooks: { register(name: string, run: unknown): void };",
    ].join("\n"),
  );
  for (const [name, source] of Object.entries(files)) {
    project.createSourceFile(name, source);
  }
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [typescriptPack(patterns)],
  });
  return found(await adapter.extractAll(), "declared-discovery");
}

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-declared-discovery-")),
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function written(
  dir: string,
  files: Record<string, string>,
): { base: string; paths: string[] } {
  const base = path.join(root, dir);
  const paths = Object.entries(files).map(([name, source]) => {
    const file = path.join(base, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  });
  return { base, paths };
}

async function pythonUnits(
  dir: string,
  files: Record<string, string>,
  patterns: DeclaredDiscoveryPattern[],
): Promise<string[]> {
  const { base, paths } = written(dir, files);
  const { summaries } = await extractPythonProject({
    files: paths,
    roots: [base],
    packs: [dataPack(patterns)],
    workspaceRoot: base,
    cacheDir: null,
  });
  return found(summaries, "declared-discovery");
}

async function rubyUnits(
  dir: string,
  files: Record<string, string>,
  patterns: DeclaredDiscoveryPattern[],
): Promise<string[]> {
  const { base, paths } = written(dir, files);
  const { summaries } = await extractRubyProject({
    files: paths,
    packs: [dataPack(patterns)],
    workspaceRoot: base,
    cacheDir: null,
  });
  return found(summaries, "declared-discovery");
}

/** A manifest that says the platform calls `handler` in a file called `handlers`, and a class method in `reports`. */
function manifestEntries(file: string): ManifestEntry[] {
  const deployed = (name: string): UnitSpec => ({
    kind: "handler",
    name,
    invocationInfo: { deploymentTarget: "lambda", instanceName: name },
  });
  const base = path.basename(file).replace(/\.[a-z]+$/, "");
  if (base === "handlers") {
    return ["handler", "aliased", "absent"].map((name) => ({
      path: [name],
      units: [deployed(`Orders.${name}`)],
    }));
  }
  return base === "reports"
    ? [
        {
          path: ["Reports", "Nightly"],
          member: { name: "run", singleton: true },
          units: [deployed("Reports.run")],
        },
      ]
    : [];
}

const MANIFEST: DeclaredDiscoveryPattern[] = [
  { kind: "handler", match: { type: "manifest", entries: manifestEntries } },
];

describe("manifest", () => {
  it("finds the function at the path the manifest spells, followed through a name bound to it, in all three languages", async () => {
    const expected = [
      "handler Orders.aliased unit-invocation",
      "handler Orders.handler unit-invocation",
    ];
    expect(
      await typescriptUnits(
        {
          "/handlers.ts": [
            "export async function handler(event: unknown) { return event; }",
            "function real(event: unknown) { return event; }",
            "export const aliased = real;",
          ].join("\n"),
        },
        MANIFEST,
      ),
    ).toEqual(expected);
    expect(
      await pythonUnits(
        "manifest-py",
        {
          "handlers.py": [
            "def handler(event, context):",
            "    return event",
            "",
            "def real(event, context):",
            "    return event",
            "",
            "aliased = real",
            "",
          ].join("\n"),
        },
        MANIFEST,
      ),
    ).toEqual(expected);
  });

  it("finds a Ruby class method through the module the class is nested in, and through a class written with its whole path", async () => {
    const units = await rubyUnits(
      "manifest-rb",
      {
        "handlers.rb": "def handler(event:, context:)\n  event\nend\n",
        "reports.rb": [
          "module Reports",
          "  class Nightly",
          "    def self.run(event:, context:)",
          "      event",
          "    end",
          "  end",
          "end",
          "",
        ].join("\n"),
      },
      MANIFEST,
    );
    expect(units).toEqual([
      "handler Orders.handler unit-invocation",
      "handler Reports.run unit-invocation",
    ]);

    const compact = await rubyUnits(
      "manifest-rb-compact",
      {
        "reports.rb":
          "class Reports::Nightly\n  def self.run(event:, context:)\n    event\n  end\nend\n",
      },
      MANIFEST,
    );
    expect(compact).toEqual(["handler Reports.run unit-invocation"]);
  });
});

const HANDLERS: DeclaredDiscoveryPattern[] = [
  {
    kind: "handler",
    match: {
      type: "namedExport",
      pattern: "^handle",
      skipFiles: ["**/*_test.*", "**/*.test.*"],
    },
  },
];

describe("namedExport", () => {
  it("takes the exports whose name the pattern matches, outside the skipped files, in all three languages", async () => {
    const expected = ["handler handle_order function-call"];
    const source = {
      ts: "export function handle_order() { return 1; }\nexport function helper() { return 2; }\n",
      py: "def handle_order():\n    return 1\n\ndef helper():\n    return 2\n",
      rb: "def handle_order\n  1\nend\n\ndef helper\n  2\nend\n",
    };
    expect(
      await typescriptUnits(
        { "/orders.ts": source.ts, "/orders.test.ts": source.ts },
        HANDLERS,
      ),
    ).toEqual(expected);
    expect(
      await pythonUnits(
        "named-py",
        { "orders.py": source.py, "orders_test.py": source.py },
        HANDLERS,
      ),
    ).toEqual(expected);
    expect(
      await rubyUnits(
        "named-rb",
        { "orders.rb": source.rb, "orders_test.rb": source.rb },
        HANDLERS,
      ),
    ).toEqual(expected);
  });

  // Ruby states no export for a constant's hash, so only a language that
  // exports an object written out has an entry object.
  it("takes the listed members of an exported object as the units each one says, in TypeScript and Python", async () => {
    const members: DeclaredDiscoveryPattern[] = [
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
                routeInfo: { method: "*", path: null },
              },
              queue: {
                kind: "consumer",
                name: "queue",
                channelInfo: { messageBus: "cloudflare-queues", channel: null },
              },
            },
          },
        },
      },
    ];
    const expected = ["consumer queue message-bus", "handler fetch rest"];
    expect(
      await typescriptUnits(
        {
          "/worker.ts": [
            "function drain(batch: unknown) { return batch; }",
            "export default {",
            "  fetch(request: unknown) { return request; },",
            "  queue: drain,",
            "  other() { return 1; },",
            "};",
          ].join("\n"),
        },
        members,
      ),
    ).toEqual(expected);
    expect(
      await pythonUnits(
        "members-py",
        {
          "worker.py": [
            "def serve(request):",
            "    return request",
            "",
            "def drain(batch):",
            "    return batch",
            "",
            'default = {"fetch": serve, "queue": drain, "other": serve}',
            "",
          ].join("\n"),
        },
        members,
      ),
    ).toEqual(expected);
  });

  // Only TypeScript writes JSX, so only it has a function that returns an element.
  it("takes only a function that returns an element when the pattern asks, in TypeScript", async () => {
    const components: DeclaredDiscoveryPattern[] = [
      {
        kind: "component",
        match: {
          type: "namedExport",
          pattern: "^[A-Z]",
          bodyEndsIn: "element",
        },
      },
    ];
    expect(
      await typescriptUnits(
        {
          "/cards.tsx": [
            "export function Card() { return <div />; }",
            "export const List = () => (<><Card /></>);",
            "export function Total() { return 3; }",
          ].join("\n"),
        },
        components,
      ),
    ).toEqual(["component Card function-call", "component List function-call"]);
  });
});

const ENTRYPOINTS: DeclaredDiscoveryPattern[] = [
  {
    kind: "handler",
    match: {
      type: "subclassOf",
      inherits: { from: ["workers", "Workers"], named: ["WorkerEntrypoint"] },
      members: { kind: "instance", names: ["fetch"] },
    },
  },
];

describe("subclassOf", () => {
  it("takes the listed methods of a class whose ancestry reaches the library base, through a project class between, in all three languages", async () => {
    const expected = [
      "handler Child.fetch function-call",
      "handler Default.fetch function-call",
    ];
    expect(
      await typescriptUnits(
        {
          "/worker.ts": [
            'import { WorkerEntrypoint } from "workers";',
            "export class Default extends WorkerEntrypoint {",
            "  fetch(request: unknown) { return request; }",
            "  other() { return 1; }",
            "}",
            "class Base extends WorkerEntrypoint {}",
            "export class Child extends Base {",
            "  fetch(request: unknown) { return request; }",
            "}",
            "export class Plain {",
            "  fetch(request: unknown) { return request; }",
            "}",
          ].join("\n"),
        },
        ENTRYPOINTS,
      ),
    ).toEqual(expected);
    expect(
      await pythonUnits(
        "subclass-py",
        {
          "worker.py": [
            "from workers import WorkerEntrypoint",
            "",
            "class Default(WorkerEntrypoint):",
            "    def fetch(self, request):",
            "        return request",
            "",
            "    def other(self):",
            "        return 1",
            "",
            "class Base(WorkerEntrypoint):",
            "    pass",
            "",
            "class Child(Base):",
            "    def fetch(self, request):",
            "        return request",
            "",
            "class Plain:",
            "    def fetch(self, request):",
            "        return request",
            "",
          ].join("\n"),
        },
        ENTRYPOINTS,
      ),
    ).toEqual(expected);
    expect(
      await rubyUnits(
        "subclass-rb",
        {
          "worker.rb": [
            "class Default < Workers::WorkerEntrypoint",
            "  def fetch(request)",
            "    request",
            "  end",
            "",
            "  def other",
            "    1",
            "  end",
            "end",
            "",
            "class Base < Workers::WorkerEntrypoint",
            "end",
            "",
            "class Child < Base",
            "  def fetch(request)",
            "    request",
            "  end",
            "end",
            "",
            "class Plain",
            "  def fetch(request)",
            "    request",
            "  end",
            "end",
            "",
          ].join("\n"),
        },
        ENTRYPOINTS,
      ),
    ).toEqual(expected);
  });
});

// Only TypeScript writes a directive prologue, and Python and Ruby state
// no `marks` facts, so the member finds nothing there.
describe("marked", () => {
  const SERVER_ACTIONS: DeclaredDiscoveryPattern[] = [
    {
      kind: "action",
      match: {
        type: "marked",
        word: "use server",
        scopes: ["module", "function"],
        name: ["assignedName", "countInFile"],
        countedAs: "serverAction",
      },
    },
  ];

  it("takes every exported function of a marked module, and each marked function elsewhere, by its name or a count, in TypeScript", async () => {
    expect(
      await typescriptUnits(
        {
          "/actions.ts": [
            '"use server";',
            "export async function save(form: unknown) { return form; }",
            "export const remove = async (id: string) => id;",
          ].join("\n"),
          "/form.tsx": [
            "export function Form() {",
            '  const submit = async () => { "use server"; return 1; };',
            '  return go(submit, async () => { "use server"; return 2; });',
            "}",
            "function go(...runs: unknown[]) { return runs; }",
          ].join("\n"),
        },
        SERVER_ACTIONS,
      ),
    ).toEqual([
      "action remove function-call",
      "action save function-call",
      "action serverAction#0 function-call",
      "action submit function-call",
    ]);
  });

  it("finds nothing in Python, which writes no directive", async () => {
    expect(
      await pythonUnits(
        "marked-py",
        { "actions.py": '"use server"\n\ndef save(form):\n    return form\n' },
        SERVER_ACTIONS,
      ),
    ).toEqual([]);
  });
});

describe("registeredFunction", () => {
  const REGISTERED: DeclaredDiscoveryPattern[] = [
    {
      kind: "handler",
      match: {
        type: "registeredFunction",
        start: imported({
          from: ["workers", "Workers"],
          named: ["hooks", "*"],
        }),
        method: "register",
        handler: { at: 1 },
        nameAt: {
          at: 0,
          named: {
            fetch: { kind: "handler", name: "fetch" },
            queue: { kind: "consumer", name: "queue" },
          },
        },
      },
    },
  ];

  it("takes the function a registration call hands over, under the name the call states, in TypeScript and Python", async () => {
    const expected = [
      "consumer queue function-call",
      "handler fetch function-call",
    ];
    expect(
      await typescriptUnits(
        {
          "/boot.ts": [
            'import { hooks } from "workers";',
            "function serve(request: unknown) { return request; }",
            "function drain(batch: unknown) { return batch; }",
            'hooks.register("fetch", serve);',
            'hooks.register("queue", drain);',
            'hooks.register("tail", serve);',
            "function later() {",
            '  hooks.register("fetch", drain);',
            "}",
          ].join("\n"),
        },
        REGISTERED,
      ),
    ).toEqual(expected);
    expect(
      await pythonUnits(
        "registered-py",
        {
          "boot.py": [
            "from workers import hooks",
            "",
            "def serve(request):",
            "    return request",
            "",
            "def drain(batch):",
            "    return batch",
            "",
            'hooks.register("fetch", serve)',
            'hooks.register("queue", drain)',
            "",
          ].join("\n"),
        },
        REGISTERED,
      ),
    ).toEqual(expected);
  });

  // Only TypeScript writes JSX, so only it hands a component over as an element.
  it("follows an element to the component its tag renders, in TypeScript", async () => {
    const booted: DeclaredDiscoveryPattern[] = [
      {
        kind: "component",
        match: {
          type: "registeredFunction",
          start: imported({ from: ["workers"], named: ["hooks"] }),
          method: "register",
          handler: { at: 1, through: "element" },
        },
      },
    ];
    expect(
      await typescriptUnits(
        {
          "/main.tsx": [
            'import { hooks } from "workers";',
            "function App() { return <div />; }",
            'hooks.register("root", <App />);',
          ].join("\n"),
        },
        booted,
      ),
    ).toEqual(["component App function-call"]);
  });
});
