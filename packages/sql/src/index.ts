/**
 * What a SQL statement touches: which tables, which fields, and what it
 * picks rows by.
 *
 * A pack that meets a query written as SQL rather than through an ORM
 * hands the text here and gets the same shape its own recognizer would
 * have produced. The statement is parsed rather than pattern-matched,
 * so a join contributes every table it reads and a `WHERE` contributes
 * a selector.
 *
 * A statement this cannot parse gives back nothing, which is what a
 * reader that cannot settle something says everywhere else. The README
 * says which dialects it reads and what it leaves out.
 */

import bigquery from "node-sql-parser/build/bigquery.js";
import mysql from "node-sql-parser/build/mysql.js";
import postgresql from "node-sql-parser/build/postgresql.js";
import sqlite from "node-sql-parser/build/sqlite.js";

/** One table a statement touches, and what it does to it. */
export interface SqlAccess {
  table: string;
  kind: "read" | "write";
  /** The fields the statement states, or `["*"]` for a whole row. */
  fields: string[];
  /** The fields it picks rows by. */
  selector: string[];
}

export interface SqlReadOptions {
  /** Which dialect the statement is written in. */
  dialect?: string;
}

interface SqlParser {
  astify(sql: string, options: { database: string }): unknown;
}

interface ParserModule {
  Parser: new () => SqlParser;
}

/**
 * The dialects this reads, by the name a pack calls its store. Postgres
 * goes under both spellings, since a pack says `postgres` and the
 * parser says `postgresql`.
 */
const DIALECTS: Record<string, { module: ParserModule; database: string }> = {
  postgres: { module: postgresql as ParserModule, database: "postgresql" },
  postgresql: { module: postgresql as ParserModule, database: "postgresql" },
  mysql: { module: mysql as ParserModule, database: "mysql" },
  sqlite: { module: sqlite as ParserModule, database: "sqlite" },
  bigquery: { module: bigquery as ParserModule, database: "bigquery" },
};

/** Every table a statement touches, or nothing when it cannot be read. */
export function readSqlAccess(
  sql: string,
  options: SqlReadOptions = {},
): SqlAccess[] {
  const dialect = DIALECTS[options.dialect ?? "postgres"];
  if (dialect === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = new dialect.module.Parser().astify(sql, {
      database: dialect.database,
    });
  } catch {
    // A statement this cannot read says nothing, rather than a guess
    // built out of whatever the text happens to spell.
    return [];
  }
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  return statements.flatMap((statement) => accessesIn(statement, new Set()));
}

/**
 * The SQL a tagged template states, with each interpolation written as
 * a parameter. What a query interpolates is a value nearly every time,
 * and a parameter is how the statement would carry one anyway, so the
 * text parses as what it means.
 *
 * A caller that knows what an interpolation is passes it in
 * `substitutions`, which is how a table interpolated as an object
 * reaches the statement as its own name. An interpolation nobody can
 * settle stays a parameter, and a statement that needed one somewhere a
 * parameter cannot go reads as nothing.
 */
export function sqlFromParts(
  parts: readonly string[],
  substitutions: ReadonlyArray<string | null> = [],
): string {
  return parts
    .map((part, index) => {
      if (index === 0) {
        return part;
      }
      const settled = substitutions[index - 1];
      return `${settled ?? `$${index}`}${part}`;
    })
    .join("");
}

interface Node {
  type?: string;
  [key: string]: unknown;
}

/**
 * `defined` is every name a `WITH` clause above this one states, since
 * a query inside one can read from a sibling and that is a name rather
 * than a table.
 */
function accessesIn(statement: unknown, defined: Set<string>): SqlAccess[] {
  const node = asNode(statement);
  if (node === null) {
    return [];
  }
  if (node.type === "select") {
    return selectAccesses(node, defined);
  }
  if (node.type === "insert") {
    return oneAccess(firstTable(node.table), {
      kind: "write",
      fields: namesOf(node.columns),
      selector: [],
    });
  }
  if (node.type === "update") {
    return oneAccess(firstTable(node.table), {
      kind: "write",
      fields: refsIn(node.set).map((ref) => ref.field),
      selector: selectorFields(node.where),
    });
  }
  if (node.type === "delete") {
    return oneAccess(firstTable(node.from) ?? firstTable(node.table), {
      kind: "write",
      fields: [],
      selector: selectorFields(node.where),
    });
  }
  return [];
}

/** A statement whose table this could not read touches nothing. */
function oneAccess(
  table: string | null,
  rest: Omit<SqlAccess, "table">,
): SqlAccess[] {
  return table === null ? [] : [{ table, ...rest }];
}

/**
 * A select reads every table its `FROM` states. A column says which
 * table it belongs to when the query qualifies it, and one that is not
 * qualified belongs to the only table there is. In a join nothing can
 * settle which table an unqualified column comes from, so it is left
 * out rather than attributed to all of them.
 */
function selectAccesses(statement: Node, outer: Set<string>): SqlAccess[] {
  // A `WITH` clause states its own queries and gives each a name the
  // rest of the statement reads from. Those names are the query's own,
  // so the tables are inside the clause and the names themselves are
  // not tables at all.
  const names = new Set(outer);
  const inside: SqlAccess[] = [];
  for (const entry of Array.isArray(statement.with) ? statement.with : []) {
    const cte = asNode(entry);
    if (cte === null) {
      continue;
    }
    const name = columnName(cte.name);
    if (name === null) {
      continue;
    }
    // A query in a `WITH` can read a sibling stated before it, so the
    // names go in as each one is read.
    inside.push(...accessesIn(cte.stmt, names));
    names.add(name);
  }

  const tables = tablesIn(statement.from);
  if (tables.size === 0) {
    return inside;
  }
  const named = [...new Set(tables.values())];
  const only = named.length === 1 ? (named[0] ?? null) : null;
  const fields = new Map<string, Set<string>>();
  const selectors = new Map<string, Set<string>>();

  const record = (
    into: Map<string, Set<string>>,
    alias: string | undefined,
    field: string,
  ): void => {
    const table = alias === undefined ? only : (tables.get(alias) ?? null);
    if (table === null) {
      return;
    }
    const found = into.get(table) ?? new Set<string>();
    found.add(field);
    into.set(table, found);
  };

  for (const ref of refsIn(statement.columns)) {
    record(fields, ref.table, ref.field);
  }
  for (const ref of refsIn(statement.where)) {
    record(selectors, ref.table, ref.field);
  }

  const own = named
    .filter((table) => !names.has(table))
    .map((table) => ({
      table,
      kind: "read" as const,
      fields: [...(fields.get(table) ?? [])],
      selector: [...(selectors.get(table) ?? [])],
    }));
  return [...own, ...inside];
}

/**
 * The tables a `FROM` states, by every name the rest of the statement
 * can call them: their own, and the alias when the query gives one.
 */
function tablesIn(from: unknown): Map<string, string> {
  const tables = new Map<string, string>();
  if (!Array.isArray(from)) {
    return tables;
  }
  for (const entry of from) {
    const node = asNode(entry);
    if (node === null) {
      continue;
    }
    const table = stringOf(node.table);
    if (table === null) {
      continue;
    }
    tables.set(table, table);
    const alias = stringOf(node.as);
    if (alias !== null) {
      tables.set(alias, table);
    }
  }
  return tables;
}

function firstTable(value: unknown): string | null {
  return [...tablesIn(value).values()][0] ?? null;
}

interface FieldRef {
  table: string | undefined;
  field: string;
}

/** Every field an expression refers to, with the table it belongs to. */
function refsIn(value: unknown): FieldRef[] {
  const found: FieldRef[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const element of node) {
        walk(element);
      }
      return;
    }
    const record = asNode(node);
    if (record === null) {
      return;
    }
    if (record.type === "column_ref") {
      const field = columnName(record.column);
      if (field !== null) {
        found.push({ table: stringOf(record.table) ?? undefined, field });
      }
      return;
    }
    for (const entry of Object.values(record)) {
      walk(entry);
    }
  };
  walk(value);
  return found;
}

function selectorFields(where: unknown): string[] {
  const found: string[] = [];
  for (const ref of refsIn(where)) {
    if (!found.includes(ref.field)) {
      found.push(ref.field);
    }
  }
  return found;
}

/** The columns an insert states, which it writes as plain values. */
function namesOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => columnName(entry))
    .filter((name): name is string => name !== null);
}

/**
 * What a column is called. The parser writes a bare name as a string
 * and a quoted or qualified one as a value node, and both mean the
 * name.
 */
function columnName(value: unknown): string | null {
  const direct = stringOf(value);
  if (direct !== null) {
    return direct;
  }
  const node = asNode(value);
  if (node === null) {
    return null;
  }
  const own = stringOf(node.value);
  if (own !== null) {
    return own;
  }
  return node.expr === undefined ? null : columnName(node.expr);
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNode(value: unknown): Node | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Node)
    : null;
}
