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
  imported,
  messageSends,
  pack,
  returnedBy,
  sqlStatements,
  storageCalls,
  typed,
} from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { InputRule, OneArgument } from "@suss/recognize";

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

// A project's own dispatcher, whose call is the message: the subject is
// the channel and the body is the next argument. Ruby declares no types,
// so a typed receiver there is one the class made.
const SPREAD_OVER_THE_CALL = {
  wire: "aws_sqs",
  messages: { each: "theCall" },
  channel: [{ argument: { at: 0 } }],
  body: { argument: { at: 1 } },
  unsettledName: "nothing",
} as const;

const DISPATCHES = messageSends({
  ...SPREAD_OVER_THE_CALL,
  client: typed({ from: ["relay", "Relay"], named: ["Dispatcher"] }),
})
  .methods({ dispatch: {} })
  .example('to.dispatch("orders", { id: 1 })');

const LEDGER_SENDS = messageSends({
  ...SPREAD_OVER_THE_CALL,
  client: imported({ from: ["ledger", "Ledger"], named: ["*"] }),
})
  .methods({ publish: {} })
  .example('Ledger.publish("ledger", { id: 2 })');

// Ruby has no function a file imports, so only TypeScript and Python
// write this one.
const BARE_PUBLISHES = messageSends({
  ...SPREAD_OVER_THE_CALL,
  client: imported({ from: ["ledger"], named: ["publish"] }),
})
  .calls({})
  .example('publish("ledger", { id: 3 })');

// A client and a function imported under another name. `named` is read
// against the export, and the bare call's operation is the export it
// calls. Ruby imports nothing, so it writes the class by its own name.
const PEEKS = storageCalls({
  system: "redis",
  client: constructedFrom({ from: ["kvcache", "Kvcache"], named: ["Cache"] }),
})
  .methods({ peek: { kind: "read", selector: { at: 0 } } })
  .example('store.peek("user_online:42")');

const LOOKUPS = storageCalls({
  system: "redis",
  client: imported({ from: ["kvcache"], named: ["lookup"] }),
})
  .calls({ kind: "read", selector: { at: 0 } })
  .example('lookup("user_online:42")');

// A query builder: the table is the factory call the first call takes,
// the fields are the keys `.set` states, and the selector is the columns
// `.where` compares on the table, however far out each call is.
const QB = ["qb", "Qb"];

const BUILDER_UPDATES = storageCalls({
  system: "warehouse",
  client: constructedFrom({ from: QB, named: ["Qb"] }),
  unsettledName: "nothing",
})
  .methods({
    update: {
      kind: "write",
      fields: {
        keysOf: { of: [{ to: "chained", method: "set" }], at: 0 },
        otherwise: ["*"],
      },
      selector: {
        fieldsRead: { of: [{ to: "chained", method: "where" }], at: 0 },
        off: { at: 0 },
      },
    },
  })
  .container({
    of: [
      {
        to: "argument",
        at: 0,
        origin: constructedFrom({ from: QB, named: ["table"] }),
      },
    ],
    at: 0,
  })
  .slots("none")
  .example("records.update(t).set({ name }).where(eq(t.id, x))");

// The keys a row states, through a spread, over a list of rows, and the
// default for a call that states none.
const BUILDER_PUTS = storageCalls({
  system: "warehouse",
  client: constructedFrom({ from: QB, named: ["Qb"] }),
})
  .methods({
    put: { kind: "write", fields: { keysOf: { at: 0 }, otherwise: ["*"] } },
    putAll: { kind: "write", fields: { keysOf: { at: 0 } } },
  })
  .slots("none")
  .example("records.put({ a: 1, ...base })");

// A warehouse whose `stock` is handed the shelf when it is called on an
// area and a file when it is called on a shelf, and whose statements
// take the area off the chain for a table they leave bare.
const DEPOT = constructedFrom({
  from: ["depot", "Depot"],
  named: ["Warehouse"],
});
const AREA_OF_DEPOT = returnedBy("area", DEPOT);
const IN_DEPOT = anyOf(
  DEPOT,
  AREA_OF_DEPOT,
  returnedBy("shelf", anyOf(DEPOT, AREA_OF_DEPOT)),
);
const AREA: OneArgument = { of: [{ to: "receiver", method: "area" }], at: 0 };

const DEPOT_QUESTIONS = sqlStatements({
  system: "warehouse",
  dialect: "bigquery",
  client: IN_DEPOT,
})
  .methods({ ask: { statement: { at: 0 } } })
  .scope(AREA)
  .example('depot.area("core").ask("SELECT id FROM events")');

const DEPOT_STOCKS = storageCalls({
  system: "warehouse",
  client: IN_DEPOT,
  unsettledName: "nothing",
})
  .methods({ stock: { kind: "write" } })
  .container(
    [{ of: [{ to: "receiver", method: "shelf" }], at: 0 }, { at: 0 }],
    { qualified: true },
  )
  .scope(AREA)
  .example('depot.area("core").shelf("accounts").stock("gs://f.json")');

// A read built up over many calls before it runs. The chain is about the
// call that says the table, however many filters come between it and
// the call that runs the read.
const ROW_READS = storageCalls({
  system: "warehouse",
  client: constructedFrom({ from: ["rows", "Rows"], named: ["Client"] }),
})
  .about({ to: "receiver", method: "read" }, { calledAs: ["single"] })
  .methods({ read: { kind: "read" } })
  .container({ at: 0 })
  .example('rows.read("orders").eq("id", 1).single()');

const LANGUAGES = ["typescript", "python", "ruby"];
const PACKS = [
  pack("declared-rows", [ROW_READS], {
    languages: LANGUAGES,
    recognizedAs: "@suss/declared-test",
  }),
  pack("declared-depot", [DEPOT_QUESTIONS, DEPOT_STOCKS], {
    languages: LANGUAGES,
    recognizedAs: "@suss/declared-test",
  }),
  pack("declared-builder", [BUILDER_UPDATES, BUILDER_PUTS], {
    languages: LANGUAGES,
    recognizedAs: "@suss/declared-test",
  }),
  pack("declared-aliases", [PEEKS, LOOKUPS], {
    languages: LANGUAGES,
    recognizedAs: "@suss/declared-test",
  }),
  pack("declared-records", [RECORD_PUTS], {
    languages: LANGUAGES,
    recognizedAs: "@suss/declared-test",
  }),
  pack("declared-sends", [DISPATCHES, LEDGER_SENDS, BARE_PUBLISHES], {
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
  import { Admin, Cache, Cache as Store, lookup as find, Records } from "kvcache";
  import * as Ledger from "ledger";
  import { publish } from "ledger";
  import { Dispatcher } from "relay";
  import { Pool } from "sqldb";
  import { eq, Qb, table } from "qb";
  import { Warehouse } from "depot";
  import { Client } from "rows";

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

  export function deliver(to: Dispatcher) {
    to.dispatch("orders", "placed");
    Ledger.publish("ledger", "entered");
  }

  export function record() {
    publish("ledger", "recorded");
  }

  export function remember() {
    const store = new Store();
    store.peek("user_online:42");
  }

  export function recall() {
    find("user_online:42");
  }

  export function rename(name: string, x: number) {
    const builder = new Qb();
    const t = table("users");
    builder.update(t).set({ name }).where(eq(t.id, x));
  }

  export function keep() {
    const builder = new Qb();
    const base = { b: 2 };
    builder.put({ a: 1, ...base });
    builder.putAll([{ a: 1 }, { b: 2 }]);
    builder.put();
  }

  export function shelve() {
    const depot = new Warehouse();
    depot.area("core").ask("SELECT id FROM events");
    depot.ask("SELECT id FROM \`archive.plans\`");
    depot.area("core").shelf("accounts").stock("gs://exports/accounts.json");
    depot.area("core").stock("orders", []);
  }

  export function fetch(id: number) {
    const rows = new Client();
    rows.read("orders").select("id").eq("id", id).neq("state", "void").gt("total", 0).lt("total", 100).order("placed").limit(1).range(0, 1).single();
  }

  export function spin() {
    var cursor: any = cursor.next();
    cursor.single();
  }
`;

const PYTHON = `from kvcache import Admin, Cache, Records
from kvcache import Cache as Store, lookup as find
import ledger as Ledger
from ledger import publish
from relay import Dispatcher
from sqldb import Pool
from qb import Qb, eq, table
from depot import Warehouse
from rows import Client

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


def deliver(to: Dispatcher):
    to.dispatch("orders", "placed")
    Ledger.publish("ledger", "entered")


def record():
    publish("ledger", "recorded")


def remember():
    store = Store()
    store.peek("user_online:42")


def recall():
    find("user_online:42")


def rename(name, x):
    builder = Qb()
    t = table("users")
    builder.update(t).set({"name": name}).where(eq(t.id, x))


def rename_compared(name, x):
    builder = Qb()
    t = table("users")
    builder.update(t).set({"name": name}).where(t.id == x)


def keep():
    builder = Qb()
    base = {"b": 2}
    builder.put({"a": 1, **base})
    builder.putAll([{"a": 1}, {"b": 2}])
    builder.put()


def shelve():
    depot = Warehouse()
    depot.area("core").ask("SELECT id FROM events")
    depot.ask("SELECT id FROM \`archive.plans\`")
    depot.area("core").shelf("accounts").stock("gs://exports/accounts.json")
    depot.area("core").stock("orders", [])


def fetch(id):
    rows = Client()
    rows.read("orders").select("id").eq("id", id).neq("state", "void").gt("total", 0).lt("total", 100).order("placed").limit(1).range(0, 1).single()


def spin():
    cursor = cursor.next()
    cursor.single()
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

  def self.deliver
    to = Relay::Dispatcher.new
    to.dispatch("orders", "placed")
    Ledger.publish("ledger", "entered")
  end

  def self.remember
    store = Kvcache::Cache.new
    store.peek("user_online:42")
  end

  def self.rename(name, x)
    builder = Qb.new
    t = Qb.table("users")
    builder.update(t).set({ name: name }).where(eq(t.id, x))
  end

  def self.rename_compared(name, x)
    builder = Qb.new
    t = Qb.table("users")
    builder.update(t).set({ name: name }).where(t.id == x)
  end

  def self.keep
    builder = Qb.new
    base = { b: 2 }
    builder.put({ a: 1, **base })
    builder.putAll([{ a: 1 }, { b: 2 }])
    builder.put()
  end

  def self.shelve
    depot = Depot::Warehouse.new
    depot.area("core").ask("SELECT id FROM events")
    depot.ask("SELECT id FROM \`archive.plans\`")
    depot.area("core").shelf("accounts").stock("gs://exports/accounts.json")
    depot.area("core").stock("orders", [])
  end

  def self.fetch(id)
    rows = Rows::Client.new
    rows.read("orders").select("id").eq("id", id).neq("state", "void").gt("total", 0).lt("total", 100).order("placed").limit(1).range(0, 1).single()
  end

  def self.spin
    cursor = cursor.next()
    cursor.single()
  end
end
`;

const LIBRARIES: Record<string, string> = {
  kvcache: `
    export declare class Cache { get(key: string): unknown; peek(key: string): unknown; }
    export declare function lookup(key: string): unknown;
    export declare class Tables { drop(spec: unknown): unknown; }
    export declare class Admin { tables(): Tables; }
    export declare class Records { put(record: unknown): unknown; }
  `,
  ledger:
    "export declare function publish(queue: string, body: unknown): void;",
  relay:
    "export declare class Dispatcher { dispatch(subject: string, body: unknown): void; }",
  sqldb: "export declare class Pool { query(statement: string): unknown; }",
  qb: `
    export declare class Where { where(condition: unknown): unknown; }
    export declare class Update { set(values: unknown): Where; }
    export declare class Qb {
      update(table: unknown): Update;
      put(row?: unknown): unknown;
      putAll(rows: unknown[]): unknown;
    }
    export declare function table(name: string): unknown;
    export declare function eq(a: unknown, b: unknown): unknown;
  `,
  depot: `
    export declare class Shelf { stock(what: unknown): unknown; }
    export declare class Area {
      shelf(name: string): Shelf;
      ask(statement: string): unknown;
      stock(shelf: string, rows: unknown[]): unknown;
    }
    export declare class Warehouse {
      area(name: string): Area;
      ask(statement: string): unknown;
    }
  `,
  rows: "export declare class Client { read(table: string): any; }",
};

/** What the pack's hooks make of every call inside the TypeScript function `unit`. */
function typescriptEffects(unit: string): Effect[] {
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
    if (!Node.isCallExpression(node) || enclosingFunction(node) !== unit) {
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

/** The name of the function declaration a node is written inside. */
function enclosingFunction(node: Node): string | undefined {
  return node.getFirstAncestor(Node.isFunctionDeclaration)?.getName();
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

/** The pack's effects on the summary of the function called `unit`. */
function effectsOf(
  summaries: readonly BehavioralSummary[],
  unit: string,
): Effect[] {
  return summaries
    .filter((summary) => summary.identity.name.endsWith(unit))
    .flatMap((summary) =>
      summary.transitions.flatMap((transition) => transition.effects),
    )
    .filter(
      (effect) =>
        effect.type === "interaction" &&
        effect.binding?.recognition === "@suss/declared-test",
    );
}

async function pythonEffects(unit: string): Promise<Effect[]> {
  const { summaries } = await extractPythonProject({
    files: [path.join(root, "store/__init__.py")],
    roots: [root],
    packs: [DECLARED],
    modules: [{ name: "store", root: path.join(root, "store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return effectsOf(summaries, unit);
}

async function rubyEffects(unit: string): Promise<Effect[]> {
  const { summaries } = await extractRubyProject({
    files: [path.join(root, "lib/store.rb")],
    packs: [DECLARED],
    modules: [{ name: "store", root: path.join(root, "lib/store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return effectsOf(summaries, unit);
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
    const fromTypeScript = typescriptEffects("load").map(placeless);

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
    expect((await pythonEffects("load")).map(placeless)).toEqual(
      fromTypeScript,
    );
    expect((await rubyEffects("load")).map(placeless)).toEqual(fromTypeScript);
  });

  it("records the same sends off a typed receiver and a module imported whole", async () => {
    const fromTypeScript = typescriptEffects("deliver").map(placeless);

    expect(fromTypeScript).toEqual([
      sendOf("orders", "to.dispatch", "placed"),
      sendOf("ledger", "Ledger.publish", "entered"),
    ]);
    expect((await pythonEffects("deliver")).map(placeless)).toEqual(
      fromTypeScript,
    );
    expect((await rubyEffects("deliver")).map(placeless)).toEqual(
      fromTypeScript,
    );
  });

  it("records the same send off a bare call of an imported function in TypeScript and Python", async () => {
    const fromTypeScript = typescriptEffects("record").map(placeless);

    expect(fromTypeScript).toEqual([sendOf("ledger", "publish", "recorded")]);
    expect((await pythonEffects("record")).map(placeless)).toEqual(
      fromTypeScript,
    );
  });

  it("reads a client made from an alias of the export the origin names, in TypeScript, Python and Ruby", async () => {
    const fromTypeScript = typescriptEffects("remember").map(placeless);

    expect(fromTypeScript).toEqual([
      expect.objectContaining({
        callee: "store.peek",
        interaction: expect.objectContaining({ operation: "peek" }),
      }),
    ]);
    expect((await pythonEffects("remember")).map(placeless)).toEqual(
      fromTypeScript,
    );
    expect((await rubyEffects("remember")).map(placeless)).toEqual(
      fromTypeScript,
    );
  });

  it("names a bare call of an aliased import after the export it calls, in TypeScript and Python", async () => {
    const fromTypeScript = typescriptEffects("recall").map(placeless);

    expect(fromTypeScript).toEqual([
      expect.objectContaining({
        callee: "find",
        interaction: expect.objectContaining({ operation: "lookup" }),
      }),
    ]);
    expect((await pythonEffects("recall")).map(placeless)).toEqual(
      fromTypeScript,
    );
  });

  it("reads the table off the first call of a chain, the fields off `.set` and the columns off `.where`, in TypeScript, Python and Ruby", async () => {
    const fromTypeScript = typescriptEffects("rename").map(placeless);

    expect(fromTypeScript).toEqual([
      expect.objectContaining({
        callee: "builder.update",
        binding: expect.objectContaining({
          semantics: expect.objectContaining({ container: "users" }),
        }),
        interaction: {
          class: "storage-access",
          kind: "write",
          fields: ["name"],
          operation: "update",
          selector: ["id"],
        },
      }),
    ]);
    expect((await pythonEffects("rename")).map(placeless)).toEqual(
      fromTypeScript,
    );
    expect((await rubyEffects("rename")).map(placeless)).toEqual(
      fromTypeScript,
    );
  });

  it("reads the columns a comparison reads the same way, in Python and Ruby", async () => {
    const fromTypeScript = typescriptEffects("rename").map(placeless);

    expect((await pythonEffects("rename_compared")).map(placeless)).toEqual(
      fromTypeScript,
    );
    expect((await rubyEffects("rename_compared")).map(placeless)).toEqual(
      fromTypeScript,
    );
  });

  it("reads the keys each row states, through a spread and over a list, in TypeScript, Python and Ruby", async () => {
    const fromTypeScript = typescriptEffects("keep").map(placeless);

    expect(fromTypeScript.map(fieldsWritten)).toEqual([
      ["a", "b"],
      ["a", "b"],
      ["*"],
    ]);
    expect((await pythonEffects("keep")).map(placeless)).toEqual(
      fromTypeScript,
    );
    expect((await rubyEffects("keep")).map(placeless)).toEqual(fromTypeScript);
  });
});

describe("a pack that says where the container and the scope are along the chain", () => {
  it("takes the container from the first place that names one and the scope from the chain, in TypeScript, Python and Ruby", async () => {
    const fromTypeScript = typescriptEffects("shelve").map(placeless);

    expect(fromTypeScript.map(addressOf)).toEqual([
      ["ask", "core", "events"],
      ["ask", "archive", "plans"],
      ["stock", "core", "accounts"],
      ["stock", "core", "orders"],
    ]);
    expect((await pythonEffects("shelve")).map(placeless)).toEqual(
      fromTypeScript,
    );
    expect((await rubyEffects("shelve")).map(placeless)).toEqual(
      fromTypeScript,
    );
  });
});

describe("a pack whose chain climbs the receivers", () => {
  it("reaches a call more than eight receivers up, in TypeScript, Python and Ruby", async () => {
    const fromTypeScript = typescriptEffects("fetch").map(placeless);

    expect(fromTypeScript.map(addressOf)).toEqual([
      ["read", "default", "orders"],
    ]);
    expect((await pythonEffects("fetch")).map(placeless)).toEqual(
      fromTypeScript,
    );
    expect((await rubyEffects("fetch")).map(placeless)).toEqual(fromTypeScript);
  });

  it("stops at a receiver that comes back round to itself, in TypeScript, Python and Ruby", async () => {
    expect(typescriptEffects("spin")).toEqual([]);
    expect(await pythonEffects("spin")).toEqual([]);
    expect(await rubyEffects("spin")).toEqual([]);
  });
});

/** The operation, scope and container a storage access records. */
function addressOf(effect: unknown): readonly (string | null)[] | null {
  const written = effect as Effect;
  return written.type === "interaction" &&
    written.interaction.class === "storage-access" &&
    written.binding?.semantics.name === "storage"
    ? [
        written.interaction.operation ?? null,
        written.binding.semantics.scope,
        written.binding.semantics.container,
      ]
    : null;
}

/** The fields a storage access records, or null for any other effect. */
function fieldsWritten(effect: unknown): readonly string[] | null {
  const written = effect as Effect;
  return written.type === "interaction" &&
    written.interaction.class === "storage-access"
    ? written.interaction.fields
    : null;
}

/** A send the declared sends record, without where it was written. */
function sendOf(channel: string, callee: string, body: string): unknown {
  return {
    type: "interaction",
    binding: {
      transport: "aws_sqs",
      semantics: { name: "message-bus", messageBus: "aws_sqs", channel },
      recognition: "@suss/declared-test",
    },
    callee,
    interaction: {
      class: "message-send",
      body: { kind: "string", value: body },
    },
  };
}
