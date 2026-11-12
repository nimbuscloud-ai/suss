/**
 * Where a storage chain finds the value for each column, in TypeScript,
 * Python and Ruby. Three clients take the same two calls: one chain
 * leaves its slots to what its rules read, one declares them with
 * `.slots()`, and one declares that its calls state none.
 *
 * Each adapter writes what a compiled hook states as the transition's
 * provenance, so the three languages' summaries must agree. What the
 * declaration finds is also checked over each adapter's ops.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SyntaxKind } from "ts-morph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bindModule,
  extractPythonProject,
  parsePython,
  pythonFactSource,
  factsForFile as pythonFacts,
} from "@suss/adapter-python";
import {
  extractRubyProject,
  parseRuby,
  rubyFactSource,
  factsForFile as rubyFacts,
} from "@suss/adapter-ruby";
import {
  createTypeScriptAdapter,
  factSourceFor,
  ResolutionStore,
  statedFactKey,
} from "@suss/adapter-typescript";
import {
  constructedFrom,
  pack,
  slotsDeclared,
  storageCalls,
} from "@suss/recognize";
import { factCallOps } from "@suss/recognize/ops";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary, ValueRef } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { FactSource, ValueOps } from "@suss/extractor";
import type { DeclaredSlots, InputRule, StorageCalls } from "@suss/recognize";

/** The keys of the objects under each of these keys of the input. */
const keysUnder =
  (...keys: string[]): InputRule =>
  ({ input }) =>
    keys.flatMap((key) => keysOf(input.property(key)));

function keysOf(value: ValueOps | null): string[] {
  return (value?.entries("nothing") ?? []).flatMap((entry) =>
    entry.key === null ? [] : [entry.key],
  );
}

// A read lists its columns under `select` as flags, the way Prisma's do,
// so what the read's rule reads there is no value for the column.
const SLOTS: DeclaredSlots = {
  selector: [["where"]],
  field: [["data"]],
  fieldsOn: ["write"],
};

/** The container is the second argument, so each effect says which chain made it. */
function chainOn(client: string): StorageCalls {
  return storageCalls({
    system: "records",
    client: constructedFrom({ from: ["kvcache", "Kvcache"], named: [client] }),
  })
    .methods({
      put: {
        kind: "write",
        selector: { of: { at: 0 }, by: keysUnder("where") },
        fields: { of: { at: 0 }, by: keysUnder("data") },
      },
      get: {
        kind: "read",
        selector: { of: { at: 0 }, by: keysUnder("where") },
        fields: { of: { at: 0 }, by: keysUnder("select") },
      },
    })
    .container({ at: 1 });
}

const DECLARED = pack(
  "declared-slots",
  [
    chainOn("Recorded"),
    chainOn("Declared").slots(SLOTS),
    chainOn("Unstated").slots("none"),
  ],
  {
    languages: ["typescript", "python", "ruby"],
    recognizedAs: "@suss/declared-slots-test",
  },
);

const TYPESCRIPT = `
import { Declared, Recorded, Unstated } from "kvcache";

const recorded = new Recorded();
const declared = new Declared();
const unstated = new Unstated();

export function rename(key: number, n: string) {
  recorded.put({ where: { id: key }, data: { name: n } }, "recorded");
  recorded.get({ where: { id: key }, select: { name: true } }, "recorded");
  declared.put({ where: { id: key }, data: { name: n } }, "declared");
  declared.get({ where: { id: key }, select: { name: true } }, "declared");
  unstated.put({ where: { id: key }, data: { name: n } }, "unstated");
  unstated.get({ where: { id: key }, select: { name: true } }, "unstated");
}
`;

const PYTHON = `from kvcache import Declared, Recorded, Unstated

recorded = Recorded()
declared = Declared()
unstated = Unstated()


def rename(key, n):
    recorded.put({"where": {"id": key}, "data": {"name": n}}, "recorded")
    recorded.get({"where": {"id": key}, "select": {"name": True}}, "recorded")
    declared.put({"where": {"id": key}, "data": {"name": n}}, "declared")
    declared.get({"where": {"id": key}, "select": {"name": True}}, "declared")
    unstated.put({"where": {"id": key}, "data": {"name": n}}, "unstated")
    unstated.get({"where": {"id": key}, "select": {"name": True}}, "unstated")
`;

const RUBY = `module Store
  def self.rename(key, n)
    recorded = Kvcache::Recorded.new
    declared = Kvcache::Declared.new
    unstated = Kvcache::Unstated.new
    recorded.put({ where: { id: key }, data: { name: n } }, "recorded")
    recorded.get({ where: { id: key }, select: { name: true } }, "recorded")
    declared.put({ where: { id: key }, data: { name: n } }, "declared")
    declared.get({ where: { id: key }, select: { name: true } }, "declared")
    unstated.put({ where: { id: key }, data: { name: n } }, "unstated")
    unstated.get({ where: { id: key }, select: { name: true } }, "unstated")
  end
end
`;

/** The same hooks, as Python and Ruby take a pack. */
const HOOKS = {
  name: "declared-slots",
  protocol: "in-process",
  discovery: [],
  invocationRecognizers: DECLARED.invocationRecognizers ?? [],
  accessRecognizers: DECLARED.accessRecognizers ?? [],
};

/** One provenance entry, with the effect it points at named by container and operation. */
interface SlotSaid {
  readonly at: string | null;
  readonly slot: string;
  readonly name: string;
  readonly from: readonly ValueRef[];
}

function slotsOf(summaries: readonly BehavioralSummary[]): SlotSaid[] {
  return unitOf(summaries).transitions.flatMap((transition) =>
    (transition.provenance ?? []).map(({ at, from }) => ({
      at: accessAt(transition.effects[at.effect]),
      slot: at.slot,
      name: at.name,
      from,
    })),
  );
}

/** The accesses the chains recorded, by container and operation. */
function accessesOf(summaries: readonly BehavioralSummary[]): string[] {
  return unitOf(summaries)
    .transitions.flatMap((transition) => transition.effects)
    .flatMap((effect) => {
      const at = accessAt(effect);
      return at === null ? [] : [at];
    });
}

function unitOf(summaries: readonly BehavioralSummary[]): BehavioralSummary {
  const unit = summaries.find((summary) =>
    summary.identity.name.endsWith("rename"),
  );
  if (unit === undefined) {
    throw new Error("no summary for rename");
  }
  return unit;
}

function accessAt(
  effect: BehavioralSummary["transitions"][number]["effects"][number],
): string | null {
  if (
    effect?.type !== "interaction" ||
    effect.binding?.semantics.name !== "storage" ||
    effect.interaction.class !== "storage-access"
  ) {
    return null;
  }
  return `${effect.binding.semantics.container}.${effect.interaction.operation}`;
}

const CLIENTS = ["Recorded", "Declared", "Unstated"];

/** A project with the client library and `/store.ts`. */
function typescriptProject() {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/kvcache/package.json",
    JSON.stringify({ name: "kvcache", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/kvcache/index.d.ts",
    CLIENTS.map(
      (name) =>
        `export declare class ${name} { put(call: unknown, table: string): unknown; get(call: unknown, table: string): unknown; }`,
    ).join("\n"),
  );
  return { project, file: project.createSourceFile("/store.ts", TYPESCRIPT) };
}

async function typescriptSummaries(): Promise<BehavioralSummary[]> {
  const { project } = typescriptProject();
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [DECLARED],
    cacheDir: null,
  });
  return adapter.extractAll();
}

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-declared-slots-")),
  );
  fs.mkdirSync(path.join(root, "store"));
  fs.writeFileSync(path.join(root, "store/__init__.py"), PYTHON);
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/store.rb"), RUBY);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function pythonSummaries(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: [path.join(root, "store/__init__.py")],
    roots: [root],
    packs: [HOOKS],
    modules: [{ name: "store", root: path.join(root, "store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

async function rubySummaries(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: [path.join(root, "lib/store.rb")],
    packs: [HOOKS],
    modules: [{ name: "store", root: path.join(root, "lib") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

/** The first argument of each call to `put` and `get`, in source order, with what the call is. */
interface Stated {
  readonly method: string;
  readonly options: ValueOps | null;
}

function typescriptCalls(): Stated[] {
  const { file } = typescriptProject();
  const store = new ResolutionStore();
  const source = factSourceFor(store);
  return file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .flatMap((call) => {
      const ops = factCallOps(statedFactKey(call, store), source);
      const method = ops?.method() ?? null;
      return method === "put" || method === "get"
        ? [{ method, options: ops?.valueAt(0) ?? null }]
        : [];
    });
}

async function pythonCalls(): Promise<Stated[]> {
  const tree = await parsePython(PYTHON);
  const db = pythonFacts({
    file: "store.py",
    root: tree.rootNode,
    module: bindModule(tree.rootNode),
    packs: [],
  });
  return callsIn(db, pythonFactSource(db));
}

async function rubyCalls(): Promise<Stated[]> {
  const tree = await parseRuby(RUBY);
  const db = rubyFacts({ file: "store.rb", root: tree.rootNode, packs: [] });
  return callsIn(db, rubyFactSource(db));
}

function callsIn(db: Database, source: FactSource): Stated[] {
  return db
    .facts("call")
    .map((row) => String(row[0]))
    .sort((a, b) => startOf(a) - startOf(b))
    .flatMap((call) => {
      const ops = factCallOps(call, source);
      const method = ops?.method() ?? null;
      return method === "put" || method === "get"
        ? [{ method, options: ops?.valueAt(0) ?? null }]
        : [];
    });
}

/** Where a node key starts in its file, `store.py:120-180` giving 120. */
function startOf(key: string): number {
  return Number((key.split(":")[1] ?? "").split("-")[0]);
}

/** What the declaration finds in each call, with each value as an effect argument. */
function declaredIn(calls: readonly Stated[]): unknown[] {
  return calls.map(({ method, options }) =>
    slotsDeclared(options, SLOTS, {
      selector: ["id"],
      fields: ["name"],
      kind: method === "put" ? "write" : "read",
    }).map((one) => [method, one.slot, one.name, one.value.asArg()]),
  );
}

const fromInput = (inputRef: string): ValueRef[] => [
  { type: "input", inputRef, path: [] },
];

const named = (name: string) => ({ kind: "identifier", name });

describe("the slots a declared storage chain states", () => {
  it("gives TypeScript's summaries the declared slots, and the recorded ones without the link", async () => {
    expect(slotsOf(await typescriptSummaries())).toEqual([
      {
        at: "recorded.put",
        slot: "field",
        name: "name",
        from: fromInput("n"),
      },
      {
        at: "recorded.put",
        slot: "selector",
        name: "id",
        from: fromInput("key"),
      },
      // The recording gives the read's column the flag its select wrote.
      {
        at: "recorded.get",
        slot: "field",
        name: "name",
        from: [{ type: "literal", value: true }],
      },
      {
        at: "recorded.get",
        slot: "selector",
        name: "id",
        from: fromInput("key"),
      },
      {
        at: "declared.put",
        slot: "field",
        name: "name",
        from: fromInput("n"),
      },
      {
        at: "declared.put",
        slot: "selector",
        name: "id",
        from: fromInput("key"),
      },
      {
        at: "declared.get",
        slot: "selector",
        name: "id",
        from: fromInput("key"),
      },
    ]);
  });

  it("finds the same values under the declared paths in TypeScript, Python and Ruby", async () => {
    const found = declaredIn(typescriptCalls());

    expect(found).toHaveLength(6);
    expect(found.slice(0, 2)).toEqual([
      [
        ["put", "selector", "id", named("key")],
        ["put", "field", "name", named("n")],
      ],
      [["get", "selector", "id", named("key")]],
    ]);
    expect(declaredIn(await pythonCalls())).toEqual(found);
    expect(declaredIn(await rubyCalls())).toEqual(found);
  });

  it("gives Python's and Ruby's summaries the same slots as TypeScript's", async () => {
    const typescript = await typescriptSummaries();

    expect(accessesOf(typescript)).toHaveLength(6);
    for (const summaries of [await pythonSummaries(), await rubySummaries()]) {
      expect(accessesOf(summaries)).toEqual(accessesOf(typescript));
      expect(slotsOf(summaries)).toEqual(slotsOf(typescript));
    }
  });
});
