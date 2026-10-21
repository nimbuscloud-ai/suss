// Tables declared the way a Drizzle project declares them, including a
// factory imported under another name and a name built from two parts.

import {
  integer,
  pgTable,
  serial,
  pgTable as table,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sqliteTable, text as sqliteText } from "drizzle-orm/sqlite-core";

export const users = pgTable("users", {
  id: serial("id"),
  email: text("email"),
  name: text("name"),
  lastSeen: timestamp("last_seen"),
});

export const orders = pgTable("orders", {
  id: serial("id"),
  userId: integer("user_id"),
  total: integer("total"),
});

const AUDIT = "audit" + "_log";
export const auditLog = table(AUDIT, { id: serial("id"), action: text("action") });

export const sessions = sqliteTable("sessions", {
  token: sqliteText("token"),
  userId: sqliteText("user_id"),
});
