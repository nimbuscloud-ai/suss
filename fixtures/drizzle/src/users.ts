// The builder calls: select, insert, update and delete, with their
// fields, values and where clauses written in several ways.

import { and, desc, eq, gt, or } from "drizzle-orm";

import { db } from "./db.js";
import { auditLog, orders, sessions, users } from "./schema.js";

export async function getUser(id: number) {
  return db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, id));
}

export async function findUser(email: string, name: string) {
  return db
    .select()
    .from(users)
    .where(and(eq(users.email, email), or(eq(users.name, name), gt(users.id, 0))))
    .orderBy(desc(users.lastSeen))
    .limit(1);
}

export async function emails() {
  return db.selectDistinct({ email: users.email }).from(users);
}

export async function ordersWithOwners() {
  return db
    .select({ total: orders.total, email: users.email })
    .from(orders)
    .leftJoin(users, eq(orders.userId, users.id));
}

export async function createUser(email: string) {
  return db.insert(users).values({ email, name: "new" }).returning();
}

export async function createFromDefaults(email: string) {
  const defaults = { name: "new" };
  const row = { email, ...defaults };
  return db.insert(users).values(row).returning();
}

export async function createMany(emails: string[]) {
  return db
    .insert(users)
    .values([{ email: emails[0] }, { email: emails[1], name: "second" }])
    .onConflictDoNothing();
}

export async function rename(id: number, name: string) {
  return db.update(users).set({ name }).where(eq(users.id, id)).returning();
}

export async function drop(id: number) {
  return db.delete(orders).where(eq(orders.id, id));
}

export async function purge() {
  return db.delete(sessions);
}

export async function recentAudit() {
  return db.select().from(auditLog);
}

export async function place(email: string, total: number) {
  return db.transaction(async (tx) => {
    await tx.insert(users).values({ email });
    await tx.insert(orders).values({ total });
  });
}

// The table read through a local name: the where clause compares the
// local's text, so no selector is read from it.
export async function byLocalName(id: number) {
  const u = users;
  return db.select().from(u).where(eq(u.id, id));
}

// The select call held in a variable before `.from`.
export async function stagedSelect() {
  const query = db.select();
  return query.from(orders);
}

// A condition built by a helper before the call.
function activeOnly(since: number) {
  return gt(users.lastSeen, since);
}

export async function active(since: number) {
  return db.select().from(users).where(activeOnly(since));
}
