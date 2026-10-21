// A database the project only declares, typed the ways current
// drizzle-orm releases type it.

import type { DrizzleDatabase } from "drizzle-orm";

import { orders, users } from "./schema.js";

type Db = DrizzleDatabase & { $client: unknown };
type MaybeDb = Db | undefined;
interface ReportDb extends DrizzleDatabase {
  region: string;
}

declare const joined: DrizzleDatabase & { $client: unknown };
declare const optional: DrizzleDatabase | undefined;
declare const aliased: Db;
declare const maybe: MaybeDb;
declare const extended: ReportDb;

export async function fromJoined() {
  return joined.select().from(users);
}

export async function fromOptional() {
  return optional!.insert(orders).values({ total: 1 });
}

export async function fromAlias() {
  return aliased.update(users).set({ name: "x" });
}

export async function fromMaybe() {
  return maybe!.delete(orders);
}

export async function fromExtension() {
  return extended.select({ id: users.id }).from(users);
}
