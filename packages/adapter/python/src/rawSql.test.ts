/**
 * What a Python body says when it hands the database a statement it
 * wrote as SQL. A library exports a function that takes one, as
 * SQLAlchemy's `text` does, or it hands the project a client object
 * whose methods take one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { emitValueFacts, nodeId } from "./facts/values.js";
import { emitModuleImportFacts } from "./facts.js";
import { parsePython } from "./parser.js";
import { bodyCalls } from "./paths/effects.js";
import { findPythonFiles } from "./project.js";
import { rawSqlCallIds, rawSqlEffects } from "./rawSql.js";
import { bindModule } from "./scope.js";
import { bindEvaluator } from "./values/evaluator.js";

import type { Effect } from "@suss/behavioral-ir";
import type { RawSqlPattern, SqlClientPattern } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { ModuleBinding } from "./scope.js";

const SQLALCHEMY: RawSqlPattern[] = [
  { module: "sqlalchemy", functions: ["text"], storageSystem: "postgresql" },
];

/** The warehouse client and the workflow hook that reaches one, as a pack declares them. */
const WAREHOUSE: SqlClientPattern[] = [
  {
    module: "google.cloud.bigquery",
    clientTypes: ["Client"],
    statements: [
      { method: "query", argument: 0, keyword: "query" },
      { method: "query_and_wait", argument: 0, keyword: "query" },
    ],
    tables: [
      { method: "get_table", argument: 0, keyword: "table", kind: "read" },
      { method: "delete_table", argument: 0, keyword: "table", kind: "write" },
    ],
    storageSystem: "gcp.bigquery",
    dialect: "bigquery",
  },
  {
    module: "airflow.providers.google.cloud.hooks.bigquery",
    clientTypes: ["BigQueryHook"],
    statements: [
      { method: "get_records", argument: 0, keyword: "sql" },
      {
        method: "insert_job",
        argument: 0,
        keyword: "configuration",
        path: ["query", "query"],
      },
    ],
    handsBack: [
      { method: "get_client", module: "google.cloud.bigquery", name: "Client" },
    ],
    storageSystem: "gcp.bigquery",
    dialect: "bigquery",
  },
];

interface Read {
  readonly calls: readonly PyNode[];
  readonly facts: Database;
  readonly filePath: string;
}

/** The calls in the first function of `handler.py`, with the whole project's facts behind them. */
async function readProject(sources: Record<string, string>): Promise<Read> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rawsql-"));
  for (const [name, text] of Object.entries(sources)) {
    fs.writeFileSync(path.join(dir, name), text);
  }

  const db = new Database();
  const definitions = new Map<string, PyNode>();
  const files: Array<{ file: string; root: PyNode; module: ModuleBinding }> =
    [];
  let handler: PyNode | null = null;
  let filePath = "";
  for (const file of findPythonFiles(dir)) {
    const tree = await parsePython(fs.readFileSync(file, "utf8"));
    const module = bindModule(tree.rootNode);
    emitModuleImportFacts(db, file, module, { roots: [dir] });
    emitValueFacts(db, file, tree.rootNode);
    files.push({ file, root: tree.rootNode, module });
    for (const child of tree.rootNode.namedChildren) {
      if (child?.type === "function_definition") {
        definitions.set(nodeId(file, child), child);
        if (file.endsWith("handler.py") && handler === null) {
          handler = child;
          filePath = file;
        }
      }
    }
  }
  bindEvaluator(db, { files, definitions });

  // `bodyCalls` reads one function's own body, so the walk starts at
  // the definition rather than at the module.
  return { calls: bodyCalls(handler as PyNode), facts: db, filePath };
}

async function effectsFor(source: string): Promise<Effect[]> {
  const read = await readProject({ "handler.py": source });
  return rawSqlEffects(read.calls, {
    facts: read.facts,
    filePath: read.filePath,
    patterns: SQLALCHEMY,
  });
}

async function warehouseEffects(
  sources: Record<string, string>,
): Promise<Effect[]> {
  const read = await readProject(sources);
  return rawSqlEffects(read.calls, {
    facts: read.facts,
    filePath: read.filePath,
    patterns: [],
    clients: WAREHOUSE,
  });
}

function storageOf(effect: Effect) {
  if (effect.type !== "interaction") {
    throw new Error(`expected an interaction, got ${effect.type}`);
  }
  const semantics = effect.binding.semantics;
  if (semantics.name !== "storage") {
    throw new Error(`expected storage, got ${semantics.name}`);
  }
  return { semantics, interaction: effect.interaction };
}

describe("a statement a Python body writes as SQL", () => {
  it("reads the table, the fields, and what it picks rows by", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import text",
        "",
        "def load(session, tenant):",
        '    return session.execute(text("SELECT id, email FROM users WHERE tenant_id = :tenant"))',
      ].join("\n"),
    );

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0] as Effect);
    expect(semantics).toMatchObject({
      storageSystem: "postgresql",
      container: "users",
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      fields: ["id", "email"],
      selector: ["tenant_id"],
    });
  });

  it("gives a join one effect per table", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import text",
        "",
        "def load(session):",
        '    return session.execute(text("SELECT u.email, o.total FROM users u JOIN orders o ON o.user_id = u.id"))',
      ].join("\n"),
    );

    expect(
      effects.map((effect) => storageOf(effect).semantics.container),
    ).toEqual(["users", "orders"]);
  });

  it("reads a write as a write", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import text",
        "",
        "def touch(session, id):",
        '    session.execute(text("UPDATE users SET last_seen = NOW() WHERE id = :id"))',
      ].join("\n"),
    );

    expect(storageOf(effects[0] as Effect).interaction).toMatchObject({
      kind: "write",
      fields: ["last_seen"],
      selector: ["id"],
    });
  });

  it("reads a statement written across several lines, which is how a long query is written", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import text",
        "",
        "def load(session):",
        '    return session.execute(text("""',
        "        SELECT id",
        "        FROM users",
        "        WHERE active = true",
        '    """))',
      ].join("\n"),
    );

    expect(storageOf(effects[0] as Effect).semantics.container).toBe("users");
  });

  it("reads what an f-string fills in as a parameter", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import text",
        "",
        "def load(session, tenant):",
        '    return session.execute(text(f"SELECT id FROM users WHERE tenant_id = {tenant}"))',
      ].join("\n"),
    );

    expect(storageOf(effects[0] as Effect).interaction).toMatchObject({
      selector: ["tenant_id"],
    });
  });

  it("leaves a call to a function of the same name from somewhere else alone", async () => {
    expect(
      await effectsFor(
        [
          "from mylib import text",
          "",
          "def load(session):",
          '    return session.execute(text("SELECT id FROM users"))',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("reads a statement built with +", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import text",
        "",
        "def load(session):",
        '    return session.execute(text("SELECT id" + " FROM users"))',
      ].join("\n"),
    );

    expect(storageOf(effects[0] as Effect).semantics.container).toBe("users");
  });

  it("reads a statement held in a module-level name", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import text",
        "",
        'LOAD_USERS = "SELECT id, email FROM users"',
        "",
        "def load(session):",
        "    return session.execute(text(LOAD_USERS))",
      ].join("\n"),
    );

    expect(storageOf(effects[0] as Effect).interaction).toMatchObject({
      kind: "read",
      fields: ["id", "email"],
    });
  });

  it("says nothing about a statement built somewhere else", async () => {
    expect(
      await effectsFor(
        [
          "from sqlalchemy import text",
          "",
          "def load(session, statement):",
          "    return session.execute(text(statement))",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("a statement handed to a client object", () => {
  it("reads a call on a client the same function built", async () => {
    const effects = await warehouseEffects({
      "handler.py": [
        "from google.cloud import bigquery",
        "",
        "def load():",
        "    client = bigquery.Client()",
        '    return client.query("SELECT id, name FROM `analytics.core.dim_account`").result()',
      ].join("\n"),
    });

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0] as Effect);
    expect(semantics).toMatchObject({
      storageSystem: "gcp.bigquery",
      scope: "core",
      container: "dim_account",
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      fields: ["id", "name"],
    });
  });

  it("reads a client another module built", async () => {
    const effects = await warehouseEffects({
      "clients.py": [
        "from google.cloud import bigquery",
        "",
        "client = bigquery.Client()",
      ].join("\n"),
      "handler.py": [
        "from clients import client",
        "",
        "def load():",
        '    return client.query("SELECT id FROM `analytics.core.dim_account`")',
      ].join("\n"),
    });

    expect(storageOf(effects[0] as Effect).semantics).toMatchObject({
      scope: "core",
      container: "dim_account",
    });
  });

  it("reads a client the function was handed, typed by its annotation", async () => {
    const effects = await warehouseEffects({
      "handler.py": [
        "from google.cloud import bigquery",
        "",
        "def load(client: bigquery.Client):",
        '    return client.query("SELECT id FROM `analytics.core.dim_account`")',
      ].join("\n"),
    });

    expect(storageOf(effects[0] as Effect).semantics.container).toBe(
      "dim_account",
    );
  });

  it("reads a table name an f-string fills in from a constant", async () => {
    const effects = await warehouseEffects({
      "tables.py": 'ACCOUNTS = "analytics.core.dim_account"',
      "handler.py": [
        "from google.cloud.bigquery import Client",
        "from tables import ACCOUNTS",
        "",
        "def load():",
        "    client = Client()",
        '    return client.query(f"SELECT id FROM `{ACCOUNTS}`")',
      ].join("\n"),
    });

    expect(storageOf(effects[0] as Effect).semantics).toMatchObject({
      scope: "core",
      container: "dim_account",
    });
  });

  it("leaves the group at the default when the statement does not settle it", async () => {
    const effects = await warehouseEffects({
      "handler.py": [
        "from google.cloud.bigquery import Client",
        "",
        "def load(project, dataset):",
        "    client = Client()",
        '    return client.query(f"SELECT id FROM `{project}.{dataset}.dim_account`")',
      ].join("\n"),
    });

    expect(storageOf(effects[0] as Effect).semantics).toMatchObject({
      scope: "default",
      container: "dim_account",
    });
  });

  it("reads a statement written under the keyword the method takes it at", async () => {
    const effects = await warehouseEffects({
      "handler.py": [
        "from google.cloud.bigquery import Client",
        "",
        "def load():",
        "    client = Client()",
        '    return client.query(query="SELECT id FROM `analytics.core.dim_account`", location="US")',
      ].join("\n"),
    });

    expect(storageOf(effects[0] as Effect).semantics.container).toBe(
      "dim_account",
    );
  });

  it("reads a method that says which table rather than writing SQL", async () => {
    const effects = await warehouseEffects({
      "handler.py": [
        "from google.cloud.bigquery import Client",
        "",
        "def clean():",
        "    client = Client()",
        '    client.get_table("analytics.core.dim_account")',
        '    client.delete_table("analytics.core.dim_stale")',
      ].join("\n"),
    });

    expect(
      effects.map((effect) => {
        const { semantics, interaction } = storageOf(effect);
        return [semantics.container, interaction.kind];
      }),
    ).toEqual([
      ["dim_account", "read"],
      ["dim_stale", "write"],
    ]);
  });

  it("reads a statement written inside the dictionary a method takes", async () => {
    const effects = await warehouseEffects({
      "handler.py": [
        "from airflow.providers.google.cloud.hooks.bigquery import BigQueryHook",
        "",
        "def load():",
        "    hook = BigQueryHook()",
        '    return hook.insert_job(configuration={"query": {"query": "SELECT id FROM `analytics.core.dim_account`", "useLegacySql": False}})',
      ].join("\n"),
    });

    expect(storageOf(effects[0] as Effect).semantics.container).toBe(
      "dim_account",
    );
  });

  it("reads a client one of the library's own methods hands back", async () => {
    const effects = await warehouseEffects({
      "handler.py": [
        "from airflow.providers.google.cloud.hooks.bigquery import BigQueryHook",
        "",
        "def load():",
        "    hook = BigQueryHook()",
        '    return hook.get_client().query("SELECT id FROM `analytics.core.dim_account`")',
      ].join("\n"),
    });

    expect(storageOf(effects[0] as Effect).semantics.container).toBe(
      "dim_account",
    );
  });

  it("keeps the parameters a parameterised statement was written with", async () => {
    const effects = await warehouseEffects({
      "handler.py": [
        "from google.cloud.bigquery import Client",
        "",
        "def load(tier):",
        "    client = Client()",
        '    return client.query("SELECT id FROM `analytics.core.dim_account` WHERE tier = @tier")',
      ].join("\n"),
    });

    expect(storageOf(effects[0] as Effect).interaction).toMatchObject({
      selector: ["tier"],
    });
  });

  it("says nothing about a method of the same name on something else", async () => {
    expect(
      await warehouseEffects({
        "handler.py": [
          "from mylib import Client",
          "",
          "def load():",
          "    client = Client()",
          '    return client.query("SELECT id FROM `analytics.core.dim_account`")',
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("says nothing about a statement the evaluator cannot settle", async () => {
    expect(
      await warehouseEffects({
        "handler.py": [
          "from google.cloud.bigquery import Client",
          "",
          "def load(statement):",
          "    client = Client()",
          "    return client.query(statement)",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("counts a claimed call the reach walk must not report as lost", async () => {
    const read = await readProject({
      "handler.py": [
        "from google.cloud.bigquery import Client",
        "",
        "def load(statement):",
        "    client = Client()",
        "    return client.query(statement)",
      ].join("\n"),
    });

    expect(
      rawSqlCallIds(read.calls, {
        facts: read.facts,
        filePath: read.filePath,
        patterns: [],
        clients: WAREHOUSE,
      }).size,
    ).toBe(1);
  });
});
