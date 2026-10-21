import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const accountDim = pgTable("dim_account", {
  id: serial("id"),
  name: text("name"),
});
