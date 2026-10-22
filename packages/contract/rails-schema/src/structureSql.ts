/**
 * Reads the tables Rails' `db/structure.sql` declares, through
 * `readSqlSchema` in `@suss/sql`. Rails writes the file with the
 * database's own dump tool, so it is MySQL's dialect when the app's
 * database is MySQL and Postgres's otherwise.
 */

import { readSqlSchema } from "@suss/sql";

import type { SqlSchema, SqlUnreadStatement } from "@suss/sql";
import type { DumpTable } from "./table.js";

export interface StructureSqlRead {
  tables: DumpTable[];
  /** What the grammar could not read, in one line, or null when it read everything. */
  unread: string | null;
}

export function tablesInStructureSql(
  source: string,
  storageSystem: string | null,
): StructureSqlRead {
  const schema = readSqlSchema(source, {
    dialect: storageSystem === "mysql" ? "mysql" : "postgresql",
  });
  return {
    tables: schema.tables.map((table) => ({
      name: table.name,
      start: table.line,
      end: table.line,
      columns: table.columns.map((column) => ({ ...column })),
    })),
    unread: unreadLine(schema),
  };
}

/** More unread parts than this are counted rather than listed. */
const UNREAD_LISTED = 10;

function unreadLine(schema: SqlSchema): string | null {
  const count = schema.unread.length;
  if (count === 0) {
    return null;
  }
  const listed = schema.unread.slice(0, UNREAD_LISTED).map(placeOf).join(", ");
  const more = count - UNREAD_LISTED;
  return `the SQL grammar could not read ${count} ${count === 1 ? "part" : "parts"} of the ${schema.statements} table statements, so what ${count === 1 ? "it says" : "they say"} is left unchecked: ${listed}${more > 0 ? `, and ${more} more` : ""}.`;
}

function placeOf(unread: SqlUnreadStatement): string {
  const where = [unread.table, unread.column].filter(
    (part): part is string => part !== null,
  );
  return where.length === 0
    ? `line ${unread.line}`
    : `line ${unread.line} (${where.join(".")})`;
}
