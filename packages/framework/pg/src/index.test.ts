import { describe, expect, it } from "vitest";

import { packUnderTest, storageOf } from "@suss/pack-harness";
import { runExamples } from "@suss/recognize";

import { pgFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

// The declaration settles a call by where the method is declared, so a
// fixture needs the client library on disk to resolve against.
const PG_TYPES = `
  export interface QueryResult { rows: unknown[] }
  export interface QueryConfig { text: string; values?: unknown[] }
  export declare class Client {
    constructor(config?: unknown);
    connect(): Promise<void>;
    query(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult>;
  }
  export declare class PoolClient {
    query(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult>;
    release(): void;
  }
  export declare class Pool {
    constructor(config?: unknown);
    connect(): Promise<PoolClient>;
    query(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult>;
  }
`;

const pg = packUnderTest(pgFramework(), { library: { pg: PG_TYPES } });

const effectsIn = (source: string): Effect[] => pg.effectsIn(source);

const POOL = `import { Pool } from "pg";\nconst pool = new Pool({ connectionString: process.env.DATABASE_URL });`;

describe("a query on a node-postgres client", () => {
  it("reads the table, the fields and what the statement picks rows by", () => {
    const effects = effectsIn(`
      ${POOL}
      export async function findUser(id: string) {
        return pool.query("SELECT id, email FROM users WHERE id = $1", [id]);
      }
    `);

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics).toMatchObject({
      storageSystem: "postgresql",
      scope: "default",
      container: "users",
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "query",
      fields: ["id", "email"],
      selector: ["id"],
    });
  });

  it("keeps a placeholder a placeholder, so the selector is the column", () => {
    const effects = effectsIn(`
      ${POOL}
      export async function byTier(tier: string) {
        return pool.query("SELECT id FROM users WHERE tier = $1", [tier]);
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      selector: ["tier"],
    });
  });

  it("reads the statement out of the config object form", () => {
    const effects = effectsIn(`
      ${POOL}
      export async function findUser(id: string) {
        return pool.query({
          text: "SELECT email FROM users WHERE id = $1",
          values: [id],
        });
      }
    `);

    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics.container).toBe("users");
    expect(interaction).toMatchObject({ kind: "read", fields: ["email"] });
  });

  it("reads the statement out of a shorthand property in the config object", () => {
    const effects = effectsIn(`
      ${POOL}
      export async function findAccount(id: string) {
        const text = "SELECT id FROM dim_account WHERE id = $1";
        return pool.query({ text, values: [id] });
      }
    `);

    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics.container).toBe("dim_account");
    expect(interaction).toMatchObject({ kind: "read", fields: ["id"] });
  });

  it("reads a write as a write, with the columns it sets", () => {
    const effects = effectsIn(`
      ${POOL}
      export async function rename(id: string, name: string) {
        await pool.query("UPDATE users SET name = $1 WHERE id = $2", [name, id]);
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      fields: ["name"],
      selector: ["id"],
    });
  });

  it("gives a join one access per table", () => {
    const effects = effectsIn(`
      ${POOL}
      export async function report() {
        return pool.query(
          "SELECT u.email, o.total FROM users u JOIN orders o ON o.user_id = u.id",
        );
      }
    `);

    expect(
      effects.map((effect) => storageOf(effect).semantics.container),
    ).toEqual(["users", "orders"]);
  });

  it("follows a pool a project exports from a module of its own", () => {
    const effects = pg.effectsAcross(
      {
        "/db.ts": `${POOL}\nexport { pool };`,
        "/repo.ts": `
          import { pool } from "./db.js";
          export async function all() {
            return pool.query("SELECT id FROM users");
          }
        `,
      },
      "/repo.ts",
    );

    expect(storageOf(effects[0]).semantics.container).toBe("users");
  });

  it("reads a query on the client a pool hands back", () => {
    const effects = effectsIn(`
      ${POOL}
      export async function inTransaction() {
        const client = await pool.connect();
        try {
          await client.query("INSERT INTO audit_log (action) VALUES ($1)", ["x"]);
        } finally {
          client.release();
        }
      }
    `);

    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics.container).toBe("audit_log");
    expect(interaction).toMatchObject({ kind: "write", fields: ["action"] });
  });

  it("reads a statement the source built from a module constant", () => {
    const effects = effectsIn(`
      ${POOL}
      const USERS = "users";
      export async function all() {
        return pool.query(\`SELECT id FROM "\${USERS}"\`);
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("users");
  });

  it("reads a module constant written as the table without quotes", () => {
    const effects = effectsIn(`
      ${POOL}
      const USERS = "users";
      export async function find(id: string) {
        return pool.query(\`SELECT id, email FROM \${USERS} WHERE id = $1\`, [id]);
      }
    `);

    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics.container).toBe("users");
    expect(interaction).toMatchObject({
      fields: ["id", "email"],
      selector: ["id"],
    });
  });

  it("says nothing about a statement whose table nothing settles", () => {
    expect(
      effectsIn(`
        ${POOL}
        export async function all(table: string) {
          return pool.query(\`SELECT id FROM \${table}\`);
        }
      `),
    ).toEqual([]);
  });

  it("says nothing about a statement that touches no table", () => {
    expect(
      effectsIn(`
        ${POOL}
        export async function begin() {
          await pool.query("BEGIN");
        }
      `),
    ).toEqual([]);
  });

  it("reads a statement handed over as a tagged template", () => {
    const effects = pg.effectsAcross(
      {
        "/node_modules/pg-template-tag/index.d.ts":
          "export declare function sql(parts: TemplateStringsArray, ...values: unknown[]): { text: string; values: unknown[] };",
        "/node_modules/pg-template-tag/package.json": JSON.stringify({
          name: "pg-template-tag",
          types: "index.d.ts",
        }),
        "/repo.ts": `
          ${POOL}
          import sql from "pg-template-tag";
          export async function findUser(id: string) {
            return pool.query(sql\`SELECT id, email FROM users WHERE id = \${id}\`);
          }
        `,
      },
      "/repo.ts",
    );

    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics.container).toBe("users");
    expect(interaction).toMatchObject({
      fields: ["id", "email"],
      selector: ["id"],
    });
  });

  it("leaves a same-named method on something else alone", () => {
    expect(
      effectsIn(`
        declare const search: { query(text: string): Promise<unknown> };
        export async function find() {
          return search.query("SELECT id FROM users");
        }
      `),
    ).toEqual([]);
  });
});

describe("a project whose types come from DefinitelyTyped", () => {
  it("reads a query whose method @types/pg declares", () => {
    const typed = packUnderTest(pgFramework(), {
      library: { "@types/pg": PG_TYPES },
    });
    const effects = typed.effectsIn(`
      ${POOL}
      export async function all() {
        return pool.query("SELECT id FROM users");
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("users");
  });
});

describe("the pack itself", () => {
  it("fires only on a file that reaches the client library", () => {
    expect(pgFramework()).toMatchObject({
      name: "pg",
      protocol: "postgresql",
      requiresImport: ["pg", "@types/pg"],
    });
  });

  it("prices what it declared: every link is data", () => {
    expect(pgFramework().declarations?.declarations).toEqual([
      {
        name: "postgresql",
        dataLinks: 2,
        functionLinks: [],
        astLinks: [],
        example:
          'pool.query("SELECT id, email FROM users WHERE id = $1", [id])',
      },
    ]);
  });

  it("emits the effect its example says it does", () => {
    const ran = runExamples(pgFramework(), (code) =>
      effectsIn(`
        ${POOL}
        export async function example(id: string) {
          return ${code};
        }
      `),
    );

    expect(ran).toHaveLength(1);
    const { semantics, interaction } = storageOf(ran[0].effects[0]);
    expect(semantics.container).toBe("users");
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "query",
      fields: ["id", "email"],
      selector: ["id"],
    });
  });
});
