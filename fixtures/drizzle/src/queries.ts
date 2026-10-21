// The relational query API and raw SQL.

import { drizzle, sql } from "drizzle-orm";

import { db } from "./db.js";
import * as schema from "./schema.js";
import { orders, users } from "./schema.js";

const plain = drizzle({});
const literalSchema = drizzle({}, { schema: { ledger: orders } });
const scoped = drizzle({}, { schema });

export async function listUsers() {
  return db.query.users.findMany({
    columns: { id: true, email: true },
    with: { orders: true },
  });
}

export async function firstOrder() {
  return db.query.orders.findFirst();
}

export async function accountsFor() {
  return db.query.accountDim.findMany();
}

export async function noSchema() {
  return plain.query.orders.findFirst();
}

export async function missingKey() {
  return scoped.query.dim_account.findMany();
}

export async function ledger() {
  return literalSchema.query.ledger.findMany();
}

// The query table held in a variable first.
export async function viaLocal() {
  const table = db.query.users;
  return table.findMany();
}

export async function tenantUsers(tenant: string) {
  return db.execute(
    sql`SELECT id, email FROM users WHERE tenant_id = ${tenant}`,
  );
}

export async function touch(id: number) {
  return db.execute(sql`UPDATE users SET last_seen = NOW() WHERE id = ${id}`);
}

export async function renameRaw(id: number) {
  return db.execute(sql`UPDATE ${users} SET name = ${id} WHERE id = ${id}`);
}

export async function rawString() {
  return db.execute("SELECT id, email FROM users");
}

export async function readMystery(mystery: Record<string, unknown>) {
  return db.select().from(mystery);
}
