/**
 * One pack declared with `@suss/recognize`, run over the same code written
 * in TypeScript, Python and Ruby. The hooks it compiles to read only the
 * ops on their context, and each adapter hands them the ops over its own
 * facts, so the three languages have to give the same effects.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Node } from "ts-morph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject } from "@suss/adapter-python";
import { extractRubyProject } from "@suss/adapter-ruby";
import {
  accessContextFor,
  invocationContextFor,
  ResolutionStore,
} from "@suss/adapter-typescript";
import {
  anyOf,
  constructedFrom,
  pack,
  returnedBy,
  sqlStatements,
  storageCalls,
} from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { InputRule } from "@suss/recognize";

// Ruby has no imports, so a client comes from a library through the
// library's own constant, which each origin lists beside the module.
const CACHE_CALLS = storageCalls({
  system: "redis",
  client: constructedFrom("kvcache", "Kvcache"),
})
  .methods({ get: { kind: "read", selector: { at: 0 } } })
  .example('cache.get("user_online:42")');

const QUERIES = sqlStatements({
  system: "postgresql",
  dialect: "postgresql",
  client: constructedFrom("sqldb", "Sqldb"),
})
  .methods({ query: { statement: { at: 0 } } })
  .example('db.query("SELECT id, email FROM users")');

// A table dropped through what an admin client's `tables()` returns. The
// table is under `name` in the spec, which Python and Ruby pass under the
// `table` keyword and TypeScript first.
const TABLE_DROPS = storageCalls({
  system: "warehouse",
  client: anyOf(
    constructedFrom("whdb", "Whdb"),
    returnedBy("tables", constructedFrom("kvcache", "Kvcache")),
  ),
})
  .methods({ drop: { kind: "write" } })
  .container({ at: 0, keyword: "table", path: ["name"] }, { qualified: true })
  .example('admin.tables().drop({ name: "core.events" })');

// A record written with a spread in it. The table is the one written
// last, and the fields come in the order their keys were first written.
const KEYS: InputRule = ({ input }) =>
  input
    .entries("nothing")
    .flatMap((entry) => (entry.key === null ? [] : [entry.key]));

const RECORD_PUTS = storageCalls({
  system: "records",
  client: constructedFrom("kvcache", "Kvcache"),
})
  .methods({ put: { kind: "write", fields: { of: { at: 0 }, by: KEYS } } })
  .container({ at: 0, property: ["table"] })
  .example('records.put({ table: "orders", name: "x" })');

const LANGUAGES = ["typescript", "python", "ruby"];
const PACKS = [
  pack("declared-records", [RECORD_PUTS], {
    languages: LANGUAGES,
    recognizedAs: "@suss/declared-test",
  }),
  pack("declared-tables", [TABLE_DROPS], {
    languages: LANGUAGES,
    recognizedAs: "@suss/declared-test",
  }),
  pack("declared-cache", [CACHE_CALLS], {
    languages: LANGUAGES,
    recognizedAs: "@suss/declared-test",
  }),
  pack("declared-sql", [QUERIES], {
    languages: LANGUAGES,
    recognizedAs: "@suss/declared-test",
  }),
];
const INVOCATION = PACKS.flatMap((one) => one.invocationRecognizers ?? []);
const ACCESS = PACKS.flatMap((one) => one.accessRecognizers ?? []);

const TYPESCRIPT = `
  import { Admin, Cache, Records } from "kvcache";
  import { Pool } from "sqldb";

  const cache = new Cache();
  const db = new Pool();
  const admin = new Admin();
  const records = new Records();
  const draft = { table: "drafts", id: 1 };

  export function load() {
    cache.get("user_online:42");
    db.query("SELECT id, email FROM users");
    admin.tables().drop({ name: "core.events" });
    records.put({ ...draft, table: "orders", name: "x" });
  }
`;

const PYTHON = `from kvcache import Admin, Cache, Records
from sqldb import Pool

cache = Cache()
db = Pool()
admin = Admin()
records = Records()
draft = {"table": "drafts", "id": 1}


def load():
    cache.get("user_online:42")
    db.query("SELECT id, email FROM users")
    admin.tables().drop(table={"name": "core.events"})
    records.put({**draft, "table": "orders", "name": "x"})
`;

const RUBY = `module Store
  def self.load
    cache = Kvcache::Cache.new
    db = Sqldb::Pool.new
    admin = Kvcache::Admin.new
    records = Kvcache::Records.new
    draft = { table: "drafts", id: 1 }
    cache.get("user_online:42")
    db.query("SELECT id, email FROM users")
    admin.tables().drop(table: { name: "core.events" })
    records.put({ **draft, table: "orders", name: "x" })
  end
end
`;

const LIBRARIES: Record<string, string> = {
  kvcache: `
    export declare class Cache { get(key: string): unknown; }
    export declare class Tables { drop(spec: unknown): unknown; }
    export declare class Admin { tables(): Tables; }
    export declare class Records { put(record: unknown): unknown; }
  `,
  sqldb: "export declare class Pool { query(statement: string): unknown; }",
};

/** What the pack's hooks make of every call in the TypeScript source. */
function typescriptEffects(): Effect[] {
  const project = createTestProject();
  for (const [module, declarations] of Object.entries(LIBRARIES)) {
    project.createSourceFile(
      `/node_modules/${module}/package.json`,
      JSON.stringify({ name: module, types: "index.d.ts" }),
    );
    project.createSourceFile(
      `/node_modules/${module}/index.d.ts`,
      declarations,
    );
  }
  const file = project.createSourceFile("/store.ts", TYPESCRIPT);
  const store = ResolutionStore.forPacks(PACKS);
  const originatesFrom = (value: Node, module: string): boolean =>
    store.importOriginsOf(value, [module]).length > 0;
  const effects: Effect[] = [];
  file.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const anchors = (value: Node, matches: (call: Node) => boolean) =>
      store.anchorCallsOf(value, matches);
    const invoked = invocationContextFor(node, store, originatesFrom, anchors);
    for (const hook of INVOCATION) {
      effects.push(...(hook(node, invoked) ?? []));
    }
    const accessed = accessContextFor(
      node,
      file,
      store,
      originatesFrom,
      anchors,
    );
    for (const hook of ACCESS) {
      effects.push(...(hook(node, accessed) ?? []));
    }
  });
  return effects;
}

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-declared-languages-")),
  );
  fs.mkdirSync(path.join(root, "store"));
  fs.writeFileSync(path.join(root, "store/__init__.py"), PYTHON);
  fs.mkdirSync(path.join(root, "lib/store"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/store.rb"), RUBY);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const DECLARED = {
  name: "declared",
  protocol: "in-process",
  discovery: [],
  invocationRecognizers: INVOCATION,
  accessRecognizers: ACCESS,
};

/** The pack's effects on the summary of the function called `load`. */
function effectsOfLoad(summaries: readonly BehavioralSummary[]): Effect[] {
  return summaries
    .filter((summary) => summary.identity.name.endsWith("load"))
    .flatMap((summary) =>
      summary.transitions.flatMap((transition) => transition.effects),
    )
    .filter(
      (effect) =>
        effect.type === "interaction" &&
        effect.binding?.recognition === "@suss/declared-test",
    );
}

async function pythonEffects(): Promise<Effect[]> {
  const { summaries } = await extractPythonProject({
    files: [path.join(root, "store/__init__.py")],
    roots: [root],
    packs: [DECLARED],
    modules: [{ name: "store", root: path.join(root, "store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return effectsOfLoad(summaries);
}

async function rubyEffects(): Promise<Effect[]> {
  const { summaries } = await extractRubyProject({
    files: [path.join(root, "lib/store.rb")],
    packs: [DECLARED],
    modules: [{ name: "store", root: path.join(root, "lib/store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return effectsOfLoad(summaries);
}

/** An effect without where it was written, which differs between the sources. */
function placeless(effect: Effect): unknown {
  const { location: _location, ...rest } = effect as Effect & {
    location?: unknown;
  };
  return rest;
}

describe("a pack declared once", () => {
  it("records the same storage and SQL effects in TypeScript, Python and Ruby", async () => {
    const fromTypeScript = typescriptEffects().map(placeless);

    expect(fromTypeScript).toHaveLength(4);
    expect(fromTypeScript).toContainEqual(
      expect.objectContaining({
        binding: expect.objectContaining({
          semantics: expect.objectContaining({
            scope: "core",
            container: "events",
          }),
        }),
      }),
    );
    expect(fromTypeScript).toContainEqual(
      expect.objectContaining({
        binding: expect.objectContaining({
          semantics: expect.objectContaining({ container: "orders" }),
        }),
        interaction: expect.objectContaining({
          fields: ["table", "id", "name"],
        }),
      }),
    );
    expect((await pythonEffects()).map(placeless)).toEqual(fromTypeScript);
    expect((await rubyEffects()).map(placeless)).toEqual(fromTypeScript);
  });
});
