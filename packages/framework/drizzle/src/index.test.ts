import { type CallExpression, Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { drizzleFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";
import type { SourceFile } from "ts-morph";

const raise = (msg: string): never => {
  throw new Error(msg);
};

/**
 * Build an in-memory Project with a minimal `drizzle-orm` .d.ts so the
 * recognizer's type check finds the database symbol declared under
 * `node_modules/drizzle-orm/`, plus a schema module declaring tables
 * via `pgTable("...")` the way real Drizzle projects do.
 */
function makeProject(userSource: string): SourceFile {
  const project = createTestProject();

  project.createSourceFile(
    "node_modules/drizzle-orm/index.d.ts",
    `
      export interface SelectChain {
        from(table: unknown): SelectChain;
        where(condition: unknown): SelectChain;
        limit(n: number): SelectChain;
      }
      export interface InsertChain {
        values(v: unknown): InsertChain;
        returning(): Promise<unknown[]>;
      }
      export interface UpdateChain {
        set(v: unknown): UpdateChain;
        where(condition: unknown): UpdateChain;
      }
      export interface DeleteChain {
        where(condition: unknown): DeleteChain;
      }
      export interface QueryTable {
        findMany(args?: unknown): Promise<unknown[]>;
        findFirst(args?: unknown): Promise<unknown>;
      }
      export interface DrizzleDatabase {
        select(fields?: Record<string, unknown>): SelectChain;
        selectDistinct(fields?: Record<string, unknown>): SelectChain;
        insert(table: unknown): InsertChain;
        update(table: unknown): UpdateChain;
        delete(table: unknown): DeleteChain;
        transaction<T>(fn: (tx: DrizzleDatabase) => Promise<T>): Promise<T>;
        query: Record<string, QueryTable>;
        execute(statement: unknown): Promise<unknown>;
      }
      export declare function drizzle(client: unknown, config?: unknown): DrizzleDatabase;
      export declare function eq(a: unknown, b: unknown): unknown;
      export declare function and(...conditions: unknown[]): unknown;
      export declare function sql(strings: TemplateStringsArray, ...values: unknown[]): unknown;
    `,
  );
  project.createSourceFile(
    "node_modules/drizzle-orm/pg-core/index.d.ts",
    `
      export declare function pgTable(name: string, columns: Record<string, unknown>): Record<string, unknown>;
      export declare function serial(name: string): unknown;
      export declare function text(name: string): unknown;
      export declare function integer(name: string): unknown;
    `,
  );
  project.createSourceFile(
    "schema.ts",
    `
      import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";
      export const users = pgTable("users", {
        id: serial("id"),
        email: text("email"),
        name: text("name"),
      });
      export const orders = pgTable("orders", {
        id: serial("id"),
        userId: integer("user_id"),
        total: integer("total"),
      });
    `,
  );

  return project.createSourceFile("user.ts", userSource);
}

function recognizeAll(sourceFile: SourceFile): Effect[] {
  const pack = drizzleFramework();
  const recognizer = pack.invocationRecognizers?.[0] ?? raise("no recognizer");
  const effects: Effect[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const ctx = {
      call: node as CallExpression,
      sourceFile,
      extractArgs: () => [],
    };
    const emitted = recognizer(node, ctx);
    if (emitted !== null) {
      effects.push(...emitted);
    }
  });
  return effects;
}

function interactionOf(effect: Effect): Record<string, unknown> {
  if (effect.type !== "interaction") {
    throw new Error(`expected interaction, got ${effect.type}`);
  }
  return effect.interaction as unknown as Record<string, unknown>;
}

function tableOf(effect: Effect): string | null {
  if (effect.type !== "interaction") {
    throw new Error(`expected interaction, got ${effect.type}`);
  }
  const semantics = effect.binding.semantics;
  if (semantics.name !== "storage") {
    throw new Error(`expected storage, got ${semantics.name}`);
  }
  return semantics.container;
}

describe("drizzle recognizer — select chains", () => {
  it("recognizes select().from().where() once, with table, fields, selector", () => {
    const sf = makeProject(`
      import { drizzle, eq } from "drizzle-orm";
      import { users } from "./schema.js";
      const db = drizzle({});
      export async function getUser(id: number) {
        return db.select({ id: users.id, email: users.email })
          .from(users)
          .where(eq(users.id, id));
      }
    `);
    const effects = recognizeAll(sf);
    expect(effects).toHaveLength(1);
    expect(tableOf(effects[0])).toBe("users");
    const interaction = interactionOf(effects[0]);
    expect(interaction.kind).toBe("read");
    expect(interaction.operation).toBe("select");
    expect(interaction.fields).toEqual(["id", "email"]);
    expect(interaction.selector).toEqual(["id"]);
  });

  it("bare select() reads the whole row and compound where unions columns", () => {
    const sf = makeProject(`
      import { and, drizzle, eq } from "drizzle-orm";
      import { users } from "./schema.js";
      const db = drizzle({});
      export async function find(email: string, name: string) {
        return db.select().from(users)
          .where(and(eq(users.email, email), eq(users.name, name)));
      }
    `);
    const effects = recognizeAll(sf);
    expect(effects).toHaveLength(1);
    const interaction = interactionOf(effects[0]);
    expect(interaction.fields).toEqual(["*"]);
    expect(interaction.selector).toEqual(["email", "name"]);
  });
});

describe("drizzle recognizer — mutations", () => {
  it("insert().values() is a write with the value keys as fields", () => {
    const sf = makeProject(`
      import { drizzle } from "drizzle-orm";
      import { users } from "./schema.js";
      const db = drizzle({});
      export async function createUser(email: string) {
        return db.insert(users).values({ email, name: "new" }).returning();
      }
    `);
    const effects = recognizeAll(sf);
    expect(effects).toHaveLength(1);
    expect(tableOf(effects[0])).toBe("users");
    const interaction = interactionOf(effects[0]);
    expect(interaction.kind).toBe("write");
    expect(interaction.operation).toBe("insert");
    expect(interaction.fields).toEqual(["email", "name"]);
  });

  it("update().set().where() carries set keys and where columns", () => {
    const sf = makeProject(`
      import { drizzle, eq } from "drizzle-orm";
      import { users } from "./schema.js";
      const db = drizzle({});
      export async function rename(id: number, name: string) {
        return db.update(users).set({ name }).where(eq(users.id, id));
      }
    `);
    const effects = recognizeAll(sf);
    expect(effects).toHaveLength(1);
    const interaction = interactionOf(effects[0]);
    expect(interaction.kind).toBe("write");
    expect(interaction.operation).toBe("update");
    expect(interaction.fields).toEqual(["name"]);
    expect(interaction.selector).toEqual(["id"]);
  });

  it("delete().where() is a whole-row write with a selector", () => {
    const sf = makeProject(`
      import { drizzle, eq } from "drizzle-orm";
      import { orders } from "./schema.js";
      const db = drizzle({});
      export async function drop(id: number) {
        return db.delete(orders).where(eq(orders.id, id));
      }
    `);
    const effects = recognizeAll(sf);
    expect(effects).toHaveLength(1);
    expect(tableOf(effects[0])).toBe("orders");
    const interaction = interactionOf(effects[0]);
    expect(interaction.kind).toBe("write");
    expect(interaction.operation).toBe("delete");
    expect(interaction.fields).toEqual(["*"]);
    expect(interaction.selector).toEqual(["id"]);
  });

  it("recognizes calls on a transaction handle", () => {
    const sf = makeProject(`
      import { drizzle } from "drizzle-orm";
      import { orders, users } from "./schema.js";
      const db = drizzle({});
      export async function place(email: string, total: number) {
        return db.transaction(async (tx) => {
          await tx.insert(users).values({ email });
          await tx.insert(orders).values({ total });
        });
      }
    `);
    const effects = recognizeAll(sf);
    expect(effects.map(tableOf).sort()).toEqual(["orders", "users"]);
  });
});

describe("drizzle recognizer — relational query API", () => {
  it("query.<table>.findMany resolves the schema export's SQL name", () => {
    const sf = makeProject(`
      import { drizzle } from "drizzle-orm";
      import * as schema from "./schema.js";
      const db = drizzle({}, { schema });
      export async function list() {
        return db.query.users.findMany({
          columns: { id: true, email: true },
          with: { orders: true },
        });
      }
    `);
    const effects = recognizeAll(sf);
    expect(effects).toHaveLength(1);
    expect(tableOf(effects[0])).toBe("users");
    const interaction = interactionOf(effects[0]);
    expect(interaction.kind).toBe("read");
    expect(interaction.operation).toBe("findMany");
    expect(interaction.fields).toEqual(["id", "email", "orders"]);
  });

  it("findFirst without options reads the whole row", () => {
    const sf = makeProject(`
      import { drizzle } from "drizzle-orm";
      const db = drizzle({});
      export async function first() {
        return db.query.orders.findFirst();
      }
    `);
    const effects = recognizeAll(sf);
    expect(effects).toHaveLength(1);
    const interaction = interactionOf(effects[0]);
    expect(interaction.operation).toBe("findFirst");
    expect(interaction.fields).toEqual(["*"]);
  });
});

describe("drizzle recognizer — negatives", () => {
  it("ignores fluent chains on non-drizzle receivers", () => {
    const sf = makeProject(`
      const qb = {
        select: () => ({ from: (t: unknown) => ({ where: (c: unknown) => [] }) }),
        insert: (t: unknown) => ({ values: (v: unknown) => [] }),
      };
      export function lookalike() {
        qb.select().from("users");
        qb.insert("users").values({ a: 1 });
      }
    `);
    expect(recognizeAll(sf)).toHaveLength(0);
  });

  it("does not name a table when the declaration is opaque", () => {
    // The identifier's own text is not the table name. Reporting it
    // would pair this query against a schema table that spells the
    // same way, so the query keeps its effect without a table.
    const sf = makeProject(`
      import { drizzle } from "drizzle-orm";
      const db = drizzle({});
      declare const mystery: Record<string, unknown>;
      export async function readMystery() {
        return db.select().from(mystery);
      }
    `);
    const effects = recognizeAll(sf);
    expect(effects).toHaveLength(1);
    expect(tableOf(effects[0])).toBeNull();
  });
});

describe("drizzle raw SQL", () => {
  function rawEffects(source: string): Effect[] {
    const sourceFile = makeProject(source);
    const recognizers = drizzleFramework().invocationRecognizers ?? [];
    const effects: Effect[] = [];
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) {
        return;
      }
      const ctx = {
        call: node as CallExpression,
        sourceFile,
        extractArgs: () => [],
      };
      for (const recognizer of recognizers) {
        const emitted = recognizer(node, ctx);
        if (emitted !== null) {
          effects.push(...emitted);
        }
      }
    });
    return effects;
  }

  it("reads the tables a statement touches, and what it picks rows by", () => {
    const effects = rawEffects(`
      import { drizzle, sql } from "drizzle-orm";
      const db = drizzle({} as never);
      export async function activeUsers(tenant: string) {
        return db.execute(sql\`SELECT id, email FROM users WHERE tenant_id = \${tenant}\`);
      }
    `);

    expect(effects).toHaveLength(1);
    const effect = effects[0];
    if (effect?.type !== "interaction") {
      throw new Error("expected an interaction");
    }
    expect(effect.binding.semantics).toMatchObject({ container: "users" });
    expect(effect.interaction).toMatchObject({
      kind: "read",
      fields: ["id", "email"],
      selector: ["tenant_id"],
    });
  });

  it("gives a join one effect per table, which the query builder path never did", () => {
    const effects = rawEffects(`
      import { drizzle, sql } from "drizzle-orm";
      const db = drizzle({} as never);
      export async function ordersFor(id: string) {
        return db.execute(sql\`SELECT u.email, o.total FROM users u JOIN orders o ON o.user_id = u.id WHERE u.id = \${id}\`);
      }
    `);

    expect(
      effects.map((effect) =>
        effect.type === "interaction" &&
        effect.binding.semantics.name === "storage"
          ? effect.binding.semantics.container
          : null,
      ),
    ).toEqual(["users", "orders"]);
  });

  it("reads a write as a write", () => {
    const effects = rawEffects(`
      import { drizzle, sql } from "drizzle-orm";
      const db = drizzle({} as never);
      export async function touch(id: string) {
        return db.execute(sql\`UPDATE users SET last_seen = NOW() WHERE id = \${id}\`);
      }
    `);

    const effect = effects[0];
    if (effect?.type !== "interaction") {
      throw new Error("expected an interaction");
    }
    expect(effect.interaction).toMatchObject({
      kind: "write",
      fields: ["last_seen"],
      selector: ["id"],
    });
  });

  it("reads a statement that interpolates the table object, which is how a schema is written", () => {
    const effects = rawEffects(`
      import { drizzle, sql } from "drizzle-orm";
      import { users } from "./schema";
      const db = drizzle({} as never);
      export async function touch(id: string) {
        return db.execute(sql\`UPDATE \${users} SET name = \${id} WHERE id = \${id}\`);
      }
    `);

    expect(effects).toHaveLength(1);
    const effect = effects[0];
    if (effect?.type !== "interaction") {
      throw new Error("expected an interaction");
    }
    expect(effect.binding.semantics).toMatchObject({ container: "users" });
    expect(effect.interaction).toMatchObject({
      kind: "write",
      fields: ["name"],
      selector: ["id"],
    });
  });

  it("says nothing about a statement it cannot read", () => {
    expect(
      rawEffects(`
        import { drizzle, sql } from "drizzle-orm";
        const db = drizzle({} as never);
        export async function mystery(table: string) {
          return db.execute(sql\`SELECT * FROM \${table}\`);
        }
      `),
    ).toEqual([]);
  });
});
