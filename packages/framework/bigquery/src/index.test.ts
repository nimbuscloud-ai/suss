import { describe, expect, it } from "vitest";

import { packUnderTest, storageOf } from "@suss/pack-harness";
import { runExamples } from "@suss/recognize";

import { bigqueryFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

// The declarations settle a call by where the method is declared, so a
// fixture needs the client library on disk to resolve against.
const BIGQUERY_TYPES = `
  export declare class Table {
    insert(rows: unknown, options?: unknown): Promise<unknown>;
    load(source: unknown, options?: unknown): Promise<unknown>;
    getRows(options?: unknown): Promise<[unknown[]]>;
    exists(): Promise<[boolean]>;
    delete(): Promise<unknown>;
  }
  export declare class Dataset {
    table(id: string): Table;
    query(query: unknown, options?: unknown): Promise<[unknown[]]>;
  }
  export declare class BigQuery {
    constructor(options?: unknown);
    dataset(id: string): Dataset;
    query(query: unknown, options?: unknown): Promise<[unknown[]]>;
    createQueryJob(options: unknown): Promise<[unknown]>;
    createQueryStream(options: unknown): unknown;
  }
`;

const bigquery = packUnderTest(bigqueryFramework(), {
  library: { "@google-cloud/bigquery": BIGQUERY_TYPES },
});

const effectsIn = (source: string): Effect[] => bigquery.effectsIn(source);

const CLIENT = `import { BigQuery } from "@google-cloud/bigquery";\nconst bigquery = new BigQuery();`;

describe("a statement handed to a BigQuery client", () => {
  it("records the table as the container and the dataset as the scope", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function accounts() {
        return bigquery.query(
          "SELECT id, name FROM \`analytics-prod.core.dim_account\` WHERE tier = @tier",
        );
      }
    `);

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics).toMatchObject({
      storageSystem: "gcp.bigquery",
      scope: "core",
      container: "dim_account",
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "query",
      fields: ["id", "name"],
      selector: ["tier"],
    });
  });

  it("reads the statement out of the options object", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function accounts(tier: string) {
        return bigquery.query({
          query: "SELECT id FROM \`analytics-prod.core.dim_account\` WHERE tier = @tier",
          params: { tier },
          location: "US",
        });
      }
    `);

    expect(storageOf(effects[0]).semantics).toMatchObject({
      scope: "core",
      container: "dim_account",
    });
  });

  it("reads a job and a stream the same way it reads a query", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function both() {
        await bigquery.createQueryJob({ query: "SELECT id FROM \`p.core.a\`" });
        bigquery.createQueryStream({ query: "SELECT id FROM \`p.core.b\`" });
      }
    `);

    expect(
      effects.map((effect) => storageOf(effect).interaction.operation),
    ).toEqual(["createQueryJob", "createQueryStream"]);
  });

  it("reads a table the source kept in a module constant", () => {
    const effects = effectsIn(`
      ${CLIENT}
      const TABLE = "analytics-prod.core.dim_account";
      export async function accounts() {
        return bigquery.query(\`SELECT id, name FROM \\\`\${TABLE}\\\`\`);
      }
    `);

    expect(storageOf(effects[0]).semantics).toMatchObject({
      scope: "core",
      container: "dim_account",
    });
  });

  it("keeps the table when the project and dataset are built at run time", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function accounts(project: string, dataset: string) {
        return bigquery.query(
          \`SELECT id FROM \\\`\${project}.\${dataset}.dim_account\\\`\`,
        );
      }
    `);

    expect(storageOf(effects[0]).semantics).toMatchObject({
      scope: "default",
      container: "dim_account",
    });
  });

  it("says nothing about a statement whose table nothing settles", () => {
    expect(
      effectsIn(`
        ${CLIENT}
        export async function rows(table: string) {
          return bigquery.query(\`SELECT id FROM \${table}\`);
        }
      `),
    ).toEqual([]);
  });
});

describe("a call down a dataset and table chain", () => {
  it("reads an insert as a write of the table, in its dataset", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function record(rows: unknown[]) {
        await bigquery.dataset("core").table("fct_event").insert(rows);
      }
    `);

    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics).toMatchObject({
      storageSystem: "gcp.bigquery",
      scope: "core",
      container: "fct_event",
    });
    expect(interaction).toMatchObject({
      kind: "write",
      operation: "insert",
      fields: ["*"],
    });
  });

  it("reads a row listing as a read", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function rows() {
        return bigquery.dataset("core").table("dim_account").getRows();
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "read",
      operation: "getRows",
    });
  });

  it("reads a table check as a read that states no field", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function there() {
        return bigquery.dataset("core").table("dim_account").exists();
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "read",
      fields: [],
    });
  });

  it("reads a drop as a write", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function drop() {
        await bigquery.dataset("staging").table("tmp_load").delete();
      }
    `);

    expect(storageOf(effects[0]).semantics).toMatchObject({
      scope: "staging",
      container: "tmp_load",
    });
  });

  it("follows a dataset written into a variable first", () => {
    const effects = effectsIn(`
      ${CLIENT}
      const core = bigquery.dataset("core");
      export async function load(source: unknown) {
        await core.table("fct_event").load(source);
      }
    `);

    expect(storageOf(effects[0]).semantics).toMatchObject({
      scope: "core",
      container: "fct_event",
    });
  });

  it("leaves a same-named method on something else alone", () => {
    expect(
      effectsIn(`
        declare const store: { table(id: string): { delete(): Promise<void> } };
        export async function drop() {
          return store.table("x").delete();
        }
      `),
    ).toEqual([]);
  });
});

describe("the pack itself", () => {
  it("fires only on a file that reaches the client library", () => {
    expect(bigqueryFramework()).toMatchObject({
      name: "bigquery",
      protocol: "gcp.bigquery",
      requiresImport: ["@google-cloud/bigquery"],
    });
  });

  it("prices what it declared: every link is data", () => {
    expect(bigqueryFramework().declarations?.declarations).toEqual([
      {
        name: "gcp.bigquery",
        dataLinks: 2,
        functionLinks: [],
        astLinks: [],
        example:
          'bigquery.query("SELECT id, name FROM `analytics.core.dim_account`")',
      },
      {
        name: "gcp.bigquery",
        dataLinks: 4,
        functionLinks: [],
        astLinks: [],
        example: 'bigquery.dataset("core").table("dim_account").insert(rows)',
      },
    ]);
  });

  it("emits the effects its examples say it does", () => {
    const ran = runExamples(bigqueryFramework(), (code) =>
      effectsIn(`
        ${CLIENT}
        declare const rows: unknown[];
        export async function example() {
          return ${code};
        }
      `),
    );

    expect(ran).toHaveLength(2);
    expect(
      ran.map((example) => storageOf(example.effects[0]).semantics),
    ).toMatchObject([
      { scope: "core", container: "dim_account" },
      { scope: "core", container: "dim_account" },
    ]);
  });
});
