import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";

import { bigqueryClients, bigqueryFramework, withBigquery } from "./index.js";

import type { PythonPack } from "@suss/adapter-python";

/** The part of the fastapi pack a route needs to be found. */
const fastapiLike: PythonPack = {
  name: "fastapi",
  protocol: "http",
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      verbAttributeNames: { get: "GET", post: "POST", delete: "DELETE" },
      pathParamSyntax: "braces",
    },
  ],
};

describe("what the BigQuery pack declares", () => {
  it("says both libraries reach the same store, under the name the other packs use", () => {
    expect(
      bigqueryClients().map((pattern) => [
        pattern.module,
        pattern.storageSystem,
        pattern.dialect,
      ]),
    ).toEqual([
      ["google.cloud.bigquery", "gcp.bigquery", "bigquery"],
      [
        "airflow.providers.google.cloud.hooks.bigquery",
        "gcp.bigquery",
        "bigquery",
      ],
    ]);
  });

  it("says the hook hands back the client library's own client", () => {
    const hook = bigqueryClients()[1];
    expect(hook?.handsBack).toEqual([
      { method: "get_client", module: "google.cloud.bigquery", name: "Client" },
    ]);
  });

  it("takes the statement where the loaders take the table, which is second", () => {
    const client = bigqueryClients()[0];
    const loader = client?.tables?.find(
      (one) => one.method === "load_table_from_json",
    );
    expect(loader).toMatchObject({ argument: 1, keyword: "destination" });
  });

  it("composes onto a route pack rather than replacing it", () => {
    const composed = withBigquery(fastapiLike);
    expect(composed.discovery).toEqual(fastapiLike.discovery);
    expect(composed.sqlClients).toHaveLength(2);
  });

  it("stands on its own with nothing to discover", () => {
    expect(bigqueryFramework().discovery).toEqual([]);
    expect(bigqueryFramework().protocol).toBe("gcp.bigquery");
  });
});

describe("a Python service reading BigQuery", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-bigquery-py-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  async function storageIn(name: string) {
    const { summaries } = await extractPythonProject({
      files: [...findPythonFiles(tmpDir)],
      packs: [withBigquery(fastapiLike)],
      roots: [tmpDir],
    });
    return summaries
      .filter((summary) => summary.identity.name === name)
      .flatMap((summary) => summary.transitions)
      .flatMap((transition) => transition.effects)
      .flatMap((effect) =>
        effect.type === "interaction" &&
        effect.interaction.class === "storage-access"
          ? [
              {
                semantics: effect.binding.semantics,
                interaction: effect.interaction,
              },
            ]
          : [],
      );
  }

  it("reads a client another module built and a table name a third one writes", async () => {
    write("app/__init__.py", "");
    write(
      "app/warehouse.py",
      [
        "from google.cloud import bigquery",
        "",
        "client = bigquery.Client()",
      ].join("\n"),
    );
    write("app/tables.py", 'ACCOUNTS = "analytics-prod.core.dim_account"\n');
    write(
      "app/routes.py",
      [
        "from fastapi import FastAPI",
        "from app.warehouse import client",
        "from app.tables import ACCOUNTS",
        "",
        "app = FastAPI()",
        "",
        '@app.get("/accounts")',
        "def list_accounts(tier: str):",
        '    job = client.query(f"SELECT id, name FROM `{ACCOUNTS}` WHERE tier = @tier")',
        "    return job.result()",
        "",
      ].join("\n"),
    );

    const [access] = await storageIn("list_accounts");
    expect(access?.semantics).toMatchObject({
      name: "storage",
      storageSystem: "gcp.bigquery",
      scope: "core",
      container: "dim_account",
    });
    expect(access?.interaction).toMatchObject({
      kind: "read",
      fields: ["id", "name"],
      selector: ["tier"],
    });
  });

  it("reads a write through the hook's job configuration", async () => {
    write("app/__init__.py", "");
    write(
      "app/routes.py",
      [
        "from fastapi import FastAPI",
        "from airflow.providers.google.cloud.hooks.bigquery import BigQueryHook",
        "",
        "app = FastAPI()",
        "",
        '@app.post("/rollup")',
        "def build_rollup():",
        "    hook = BigQueryHook()",
        '    statement = "INSERT INTO `analytics-prod.core.fct_rollup` (id, total) VALUES (@id, @total)"',
        '    return hook.insert_job(configuration={"query": {"query": statement, "useLegacySql": False}})',
        "",
      ].join("\n"),
    );

    const [access] = await storageIn("build_rollup");
    expect(access?.semantics).toMatchObject({
      scope: "core",
      container: "fct_rollup",
    });
    expect(access?.interaction).toMatchObject({
      kind: "write",
      fields: ["id", "total"],
    });
  });

  it("reads a call that says which table without writing SQL", async () => {
    write("app/__init__.py", "");
    write(
      "app/routes.py",
      [
        "from fastapi import FastAPI",
        "from google.cloud.bigquery import Client",
        "",
        "app = FastAPI()",
        "",
        '@app.delete("/stale")',
        "def drop_stale(client: Client):",
        '    return client.delete_table("analytics-prod.core.dim_stale")',
        "",
      ].join("\n"),
    );

    const [access] = await storageIn("drop_stale");
    expect(access?.semantics).toMatchObject({
      scope: "core",
      container: "dim_stale",
    });
    expect(access?.interaction).toMatchObject({ kind: "write" });
  });

  it("says nothing about a statement whose table a caller supplies", async () => {
    write("app/__init__.py", "");
    write(
      "app/routes.py",
      [
        "from fastapi import FastAPI",
        "from google.cloud.bigquery import Client",
        "",
        "app = FastAPI()",
        "",
        '@app.get("/rows")',
        "def read_rows(client: Client, table: str):",
        '    return client.query(f"SELECT id FROM `{table}`")',
        "",
      ].join("\n"),
    );

    expect(await storageIn("read_rows")).toEqual([]);
  });
});
