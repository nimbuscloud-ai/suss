/**
 * One pack declared with `@suss/recognize`, run over the same code written
 * in TypeScript and in Python. The hooks it compiles to read only the ops
 * on their context, and each adapter hands them the ops over its own facts,
 * so the two languages have to give the same effects.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Node } from "ts-morph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject } from "@suss/adapter-python";
import {
  accessContextFor,
  invocationContextFor,
  ResolutionStore,
} from "@suss/adapter-typescript";
import {
  constructedFrom,
  pack,
  sqlStatements,
  storageCalls,
} from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

const CACHE_CALLS = storageCalls({
  system: "redis",
  client: constructedFrom("kvcache"),
})
  .methods({ get: { kind: "read", selector: { at: 0 } } })
  .example('cache.get("user_online:42")');

const QUERIES = sqlStatements({
  system: "postgresql",
  dialect: "postgresql",
  client: constructedFrom("sqldb"),
})
  .methods({ query: { statement: { at: 0 } } })
  .example('db.query("SELECT id, email FROM users")');

const PACKS = [
  pack("declared-cache", [CACHE_CALLS], {
    languages: ["typescript", "python"],
    recognizedAs: "@suss/declared-test",
  }),
  pack("declared-sql", [QUERIES], {
    languages: ["typescript", "python"],
    recognizedAs: "@suss/declared-test",
  }),
];
const INVOCATION = PACKS.flatMap((one) => one.invocationRecognizers ?? []);
const ACCESS = PACKS.flatMap((one) => one.accessRecognizers ?? []);

const TYPESCRIPT = `
  import { Cache } from "kvcache";
  import { Pool } from "sqldb";

  const cache = new Cache();
  const db = new Pool();

  export function load() {
    cache.get("user_online:42");
    db.query("SELECT id, email FROM users");
  }
`;

const PYTHON = `from kvcache import Cache
from sqldb import Pool

cache = Cache()
db = Pool()


def load():
    cache.get("user_online:42")
    db.query("SELECT id, email FROM users")
`;

const LIBRARIES: Record<string, string> = {
  kvcache: "export declare class Cache { get(key: string): unknown; }",
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
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** The pack's effects on the Python function's summary. */
async function pythonEffects(): Promise<Effect[]> {
  const { summaries } = await extractPythonProject({
    files: [path.join(root, "store/__init__.py")],
    roots: [root],
    packs: [
      {
        name: "declared",
        protocol: "in-process",
        discovery: [],
        invocationRecognizers: INVOCATION,
        accessRecognizers: ACCESS,
      },
    ],
    modules: [{ name: "store", root: path.join(root, "store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries
    .filter((summary: BehavioralSummary) => summary.identity.name === "load")
    .flatMap((summary) =>
      summary.transitions.flatMap((transition) => transition.effects),
    )
    .filter(
      (effect) =>
        effect.type === "interaction" &&
        effect.binding?.recognition === "@suss/declared-test",
    );
}

/** An effect without where it was written, which differs between the two sources. */
function placeless(effect: Effect): unknown {
  const { location: _location, ...rest } = effect as Effect & {
    location?: unknown;
  };
  return rest;
}

describe("a pack declared once", () => {
  it("records the same storage and SQL effects in TypeScript and in Python", async () => {
    const fromTypeScript = typescriptEffects().map(placeless);
    const fromPython = (await pythonEffects()).map(placeless);

    expect(fromTypeScript).toHaveLength(2);
    expect(fromPython).toEqual(fromTypeScript);
  });
});
