/**
 * Reads the tables a SQL schema dump declares, such as Rails'
 * `db/structure.sql` or what `pg_dump --schema-only` writes.
 *
 * The dump is split into statements, and `CREATE TABLE` and `ALTER TABLE`
 * are parsed with the grammar. pg_dump adds the keys and the default a
 * serial column draws on its sequence with through `ALTER TABLE`. Enum
 * types come from `CREATE TYPE ... AS ENUM`, and every other statement is
 * skipped. The grammar knows only the built-in types, so a table it
 * rejects is read one column at a time, with an unknown type set aside.
 * Whatever it still rejects is listed as unread and left unstated.
 */

import { asNode, columnName, type Node, stringOf } from "./astNodes.js";
import { DIALECTS, type Grammar, parsedStatement } from "./grammars.js";
import { CAST_TYPE, replaceInCode } from "./rewrites.js";
import { codeMask, nextToken } from "./textRuns.js";

export interface SqlSchemaOptions {
  /** Which dialect the dump is written in. Defaults to `postgresql`. */
  dialect?: string;
}

export interface SqlSchema {
  tables: SqlTable[];
  /** The table statements, and the columns of one, the grammar rejected. */
  unread: SqlUnreadStatement[];
  /** How many `CREATE TABLE` and `ALTER TABLE` statements the dump has. */
  statements: number;
}

export interface SqlTable {
  /** `orders`, or `audit.events` for a table outside the `public` schema. */
  name: string;
  /** The line its `CREATE TABLE` starts on, counting from one. */
  line: number;
  columns: SqlColumn[];
}

/** One column, with the fields a storage contract gives a column. */
export interface SqlColumn {
  name: string;
  /**
   * The type as the dump writes it, in lower case, without its length or
   * schema: `character varying`, `timestamp`, `bigint[]`. A column of an
   * enum type the dump creates has the type `enum`.
   */
  type: string;
  /** Absent when the grammar could not read the column's definition. */
  nullable?: boolean;
  primary?: boolean;
  /**
   * Whether the database fills the column when an insert leaves it out.
   * Absent when a statement that could have said was not read.
   */
  default?: boolean;
  /** The table a foreign key on this column points at. */
  foreignKey?: string;
}

/** A statement, or one column of a `CREATE TABLE`, the grammar rejected. */
export interface SqlUnreadStatement {
  line: number;
  /** The table it is about, when its first words say. */
  table: string | null;
  /** The column it is about, when it is about one. */
  column: string | null;
}

/** One statement of the dump, and the line it starts on. */
interface Statement {
  text: string;
  line: number;
}

type TableStatement = "createTable" | "alterTable";

/** How each kind of table statement starts, up to the table's name. */
const STATEMENT_HEADS: Record<TableStatement, RegExp> = {
  createTable: /^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,
  alterTable: /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?/i,
};

interface SchemaReading {
  grammar: Grammar;
  /** Every enum type the dump creates, unqualified and in lower case. */
  enums: Set<string>;
  tables: Map<string, SqlTable>;
  unread: SqlUnreadStatement[];
}

/** The tables a dump declares, and how much of it was read. */
export function readSqlSchema(
  sql: string,
  options: SqlSchemaOptions = {},
): SqlSchema {
  const grammar = DIALECTS[options.dialect ?? "postgresql"];
  if (grammar === undefined) {
    return { tables: [], unread: [], statements: 0 };
  }
  const statements = statementsIn(sql);
  const reading: SchemaReading = {
    grammar,
    enums: enumTypesIn(statements),
    tables: new Map(),
    unread: [],
  };
  let counted = 0;
  for (const statement of statements) {
    const kind = tableStatementKind(statement.text);
    if (kind === null) {
      continue;
    }
    counted += 1;
    STATEMENT_READERS[kind](statement, reading);
  }
  return {
    tables: [...reading.tables.values()],
    unread: reading.unread,
    statements: counted,
  };
}

const STATEMENT_READERS: Record<
  TableStatement,
  (statement: Statement, reading: SchemaReading) => void
> = {
  createTable: readCreateTable,
  alterTable: readAlterTable,
};

function tableStatementKind(text: string): TableStatement | null {
  for (const [kind, head] of Object.entries(STATEMENT_HEADS)) {
    if (head.test(text)) {
      return kind as TableStatement;
    }
  }
  return null;
}

/** The dump's statements, split on each `;` written in code. */
function statementsIn(sql: string): Statement[] {
  const mask = codeMask(sql);
  const found: Statement[] = [];
  let start = 0;
  let line = 1;
  for (let at = 0; at <= sql.length; at += 1) {
    if (at < sql.length && (sql[at] !== ";" || mask[at] === false)) {
      continue;
    }
    const from = nextToken(sql, start);
    if (from < at) {
      found.push({
        text: sql.slice(from, at),
        line: line + newlinesIn(sql, start, from),
      });
    }
    line += newlinesIn(sql, start, at + 1);
    start = at + 1;
  }
  return found;
}

function newlinesIn(text: string, from: number, to: number): number {
  let count = 0;
  for (let at = from; at < Math.min(to, text.length); at += 1) {
    if (text[at] === "\n") {
      count += 1;
    }
  }
  return count;
}

const CREATE_TYPE = /^CREATE\s+TYPE\s+/i;

function enumTypesIn(statements: readonly Statement[]): Set<string> {
  const enums = new Set<string>();
  for (const { text } of statements) {
    const head = CREATE_TYPE.exec(text);
    const written = head === null ? null : writtenNameAt(text, head[0].length);
    if (written === null || !/^\s*AS\s+ENUM\b/i.test(text.slice(written.end))) {
      continue;
    }
    enums.add((written.parts.at(-1) as string).toLowerCase());
  }
  return enums;
}

/** One part of a name, quoted with either quote or bare. */
const NAME_PART = /"((?:[^"]|"")*)"|`([^`]*)`|([\w$]+)/y;

/** A name, qualified or not, written at `index`, as `public.orders` or `"Audit"."Events"`. */
function writtenNameAt(
  text: string,
  index: number,
): { parts: string[]; end: number } | null {
  const parts: string[] = [];
  let at = index;
  for (;;) {
    NAME_PART.lastIndex = at;
    const match = NAME_PART.exec(text);
    if (match === null) {
      return parts.length === 0 ? null : { parts, end: at };
    }
    parts.push(
      match[1]?.replace(/""/g, '"') ?? match[2] ?? (match[3] as string),
    );
    at = NAME_PART.lastIndex;
    const dot = /^\s*\.\s*/.exec(text.slice(at, at + 16));
    if (dot === null) {
      return { parts, end: at };
    }
    at += dot[0].length;
  }
}

/** A table outside `public` keeps its schema, so two schemas' `events` stay apart. */
function qualifiedName(schema: string | null, table: string): string {
  return schema === null || schema === "public" ? table : `${schema}.${table}`;
}

function tableNameOf(parts: readonly string[]): string {
  const table = parts.at(-1) as string;
  return qualifiedName(parts.at(-2) ?? null, table);
}

/** The table written right after `head` at the start of a statement. */
function tableNamed(text: string, head: RegExp): string | null {
  const match = head.exec(text);
  const written = match === null ? null : writtenNameAt(text, match[0].length);
  return written === null ? null : tableNameOf(written.parts);
}

function readCreateTable(statement: Statement, reading: SchemaReading): void {
  const head = STATEMENT_HEADS.createTable.exec(statement.text);
  const written =
    head === null ? null : writtenNameAt(statement.text, head[0].length);
  if (written === null) {
    unread(reading, statement.line, null, null);
    return;
  }
  const table: SqlTable = {
    name: tableNameOf(written.parts),
    line: statement.line,
    columns: [],
  };
  const parsed = parsedOfType(
    parsedStatement(statement.text, reading.grammar),
    "create",
  );
  // A partition of another table lists no columns of its own.
  if (parsed !== null && !Array.isArray(parsed.create_definitions)) {
    unread(reading, statement.line, table.name, null);
    return;
  }
  if (parsed !== null) {
    readDefinitions(parsed.create_definitions, table, reading.enums);
    reading.tables.set(table.name, table);
    return;
  }
  if (readDefinitionsOneByOne(statement, written.end, table, reading)) {
    reading.tables.set(table.name, table);
    return;
  }
  unread(reading, statement.line, table.name, null);
}

/** The statement's tree when it is of `type`, and null when the grammar rejected it. */
function parsedOfType(parsed: unknown, type: string): Node | null {
  const node = asNode(Array.isArray(parsed) ? parsed[0] : parsed);
  return node?.type === type ? node : null;
}

function readDefinitions(
  definitions: unknown,
  table: SqlTable,
  enums: Set<string>,
): void {
  const nodes = (Array.isArray(definitions) ? definitions : [])
    .map(asNode)
    .filter((node): node is Node => node !== null);
  for (const node of nodes) {
    if (node.resource === "constraint") {
      applyConstraint(table, node);
      continue;
    }
    const column = node.resource === "column" ? parsedColumn(node) : null;
    if (column !== null) {
      table.columns.push(withEnumType(column, enums));
    }
  }
}

function parsedColumn(definition: Node, type?: string): SqlColumn | null {
  const name = columnName(asNode(definition.column)?.column);
  const columnType = type ?? typeOfDefinition(definition.definition);
  if (name === null || columnType === null) {
    return null;
  }
  const primary = definition.primary_key != null;
  const foreignKey = tableInTree(
    asNode(definition.reference_definition)?.table,
  );
  return {
    name,
    type: columnType,
    nullable: !primary && asNode(definition.nullable)?.type !== "not null",
    default: databaseDefault(definition, columnType),
    ...(primary ? { primary: true } : {}),
    ...(foreignKey === null ? {} : { foreignKey }),
  };
}

function withEnumType(column: SqlColumn, enums: Set<string>): SqlColumn {
  return enums.has(column.type) ? { ...column, type: "enum" } : column;
}

/** The type the grammar read, in lower case. MySQL spells a boolean `tinyint(1)`. */
function typeOfDefinition(definition: unknown): string | null {
  const node = asNode(definition);
  const dataType = stringOf(node?.dataType)?.toLowerCase();
  if (node === null || dataType === undefined) {
    return null;
  }
  const element =
    dataType === "tinyint" && node.length === 1 ? "tinyint(1)" : dataType;
  return asNode(node.array) === null ? element : `${element}[]`;
}

/** Types whose column draws on a sequence the type creates. */
const SERIAL_TYPES = new Set([
  "smallserial",
  "serial",
  "bigserial",
  "serial2",
  "serial4",
  "serial8",
]);

/** MySQL writes `DEFAULT NULL` on a column with no default. */
function databaseDefault(definition: Node, type: string): boolean {
  if (definition.auto_increment != null || SERIAL_TYPES.has(type)) {
    return true;
  }
  const value = asNode(asNode(definition.default_val)?.value);
  return value !== null && !isNullValue(value);
}

function isNullValue(value: Node): boolean {
  if (value.type === "null") {
    return true;
  }
  return value.type === "cast" && asNode(value.expr)?.type === "null";
}

/** The table a tree's table reference gives, qualified the way `qualifiedName` qualifies one. */
function tableInTree(tables: unknown): string | null {
  const node = asNode(Array.isArray(tables) ? tables[0] : tables);
  const table = stringOf(node?.table);
  return table === null ? null : qualifiedName(stringOf(node?.db), table);
}

/** The columns a key constraint lists. */
function columnsListed(definition: unknown): string[] {
  return (Array.isArray(definition) ? definition : [])
    .map((entry) => columnName(asNode(entry)?.column))
    .filter((name): name is string => name !== null);
}

const CONSTRAINT_READERS: Record<
  string,
  (table: SqlTable, columns: string[], constraint: Node) => void
> = {
  "primary key": (table, columns) => {
    for (const column of columns) {
      updateColumn(table, column, { primary: true });
    }
  },
  "foreign key": (table, columns, constraint) => {
    const target = tableInTree(asNode(constraint.reference_definition)?.table);
    if (target === null) {
      return;
    }
    for (const column of columns) {
      updateColumn(table, column, { foreignKey: target });
    }
  },
};

function applyConstraint(table: SqlTable, constraint: Node): void {
  const kind = stringOf(constraint.constraint_type)?.toLowerCase() ?? "";
  CONSTRAINT_READERS[kind]?.(
    table,
    columnsListed(constraint.definition),
    constraint,
  );
}

function updateColumn(
  table: SqlTable,
  name: string,
  change: Partial<SqlColumn>,
): void {
  const column = table.columns.find((candidate) => candidate.name === name);
  if (column !== undefined) {
    Object.assign(column, change);
  }
}

/** Words a table-level definition starts with, as opposed to a column's name. */
const TABLE_CONSTRAINT =
  /^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE|KEY|INDEX|FULLTEXT|SPATIAL)\b/i;

/**
 * A column's name, its type, and everything after the type. pg_dump
 * writes the type first, and none of these words can be part of it.
 */
const COLUMN_PARTS =
  /^("(?:[^"]|"")+"|`[^`]+`|[\w$]+)\s+([\s\S]+?)((?:\s+(?:COLLATE|DEFAULT|NOT\s+NULL|NULL|CONSTRAINT|GENERATED|CHECK|REFERENCES|PRIMARY\s+KEY|UNIQUE)\b[\s\S]*)?)$/i;

/**
 * Each definition of a table the grammar rejected, parsed on its own.
 * False when the statement has no list of definitions to read, as a
 * partition of another table does not.
 */
function readDefinitionsOneByOne(
  statement: Statement,
  afterName: number,
  table: SqlTable,
  reading: SchemaReading,
): boolean {
  const definitions = definitionsIn(statement.text, afterName);
  if (definitions === null) {
    return false;
  }
  for (const definition of definitions) {
    const line = statement.line + newlinesIn(statement.text, 0, definition.at);
    readOneDefinition(definition.text, line, table, reading);
  }
  return true;
}

function readOneDefinition(
  text: string,
  line: number,
  table: SqlTable,
  reading: SchemaReading,
): void {
  const parsed = parsedDefinitions(text, reading.grammar);
  if (parsed !== null) {
    readDefinitions(parsed, table, reading.enums);
    return;
  }
  const parts = TABLE_CONSTRAINT.test(text) ? null : COLUMN_PARTS.exec(text);
  if (parts === null) {
    unread(reading, line, table.name, null);
    return;
  }
  const [, written, typeText, rest] = parts as unknown as [
    string,
    string,
    string,
    string,
  ];
  const name = writtenNameAt(written, 0)?.parts[0] ?? written;
  const type = writtenType(typeText, reading.enums);
  // A type the grammar does not know is swapped for one it does, here and
  // in any cast, so the rest of the definition can still be read.
  const swapped = parsedDefinitions(
    `${written} text${replaceInCode(rest, ANY_CAST, castToText)}`,
    reading.grammar,
  );
  const node = asNode(Array.isArray(swapped) ? swapped[0] : null);
  const column = node === null ? null : parsedColumn(node, type);
  if (column !== null) {
    table.columns.push(column);
    return;
  }
  table.columns.push({ name, type });
  unread(reading, line, table.name, name);
}

const ANY_CAST = new RegExp(String.raw`::\s*${CAST_TYPE}`, "gi");

function castToText(): string {
  return "::text";
}

/** The definitions a one-definition table gives, or null when the grammar rejects it. */
function parsedDefinitions(definition: string, grammar: Grammar): unknown {
  const parsed = parsedOfType(
    parsedStatement(`CREATE TABLE t (${definition})`, grammar),
    "create",
  );
  return parsed === null ? null : parsed.create_definitions;
}

/** A type as written, the way `SqlColumn.type` gives one. */
function writtenType(text: string, enums: Set<string>): string {
  const array = /\[\s*\d*\s*\]/.test(text) ? "[]" : "";
  const bare = text
    .replace(/\[\s*\d*\s*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const written = writtenNameAt(bare, 0);
  const qualified = written !== null && written.end === bare.length;
  const name = (
    qualified ? (written.parts.at(-1) as string) : bare
  ).toLowerCase();
  return `${enums.has(name) ? "enum" : name}${array}`;
}

/**
 * The definitions between the parentheses after a table's name, split
 * at each top-level comma, with where each starts in `text`.
 */
function definitionsIn(
  text: string,
  from: number,
): Array<{ text: string; at: number }> | null {
  const open = nextToken(text, from);
  if (text[open] !== "(") {
    return null;
  }
  const mask = codeMask(text);
  const found: Array<{ text: string; at: number }> = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open + 1; at < text.length; at += 1) {
    if (mask[at] === false) {
      continue;
    }
    const character = text[at];
    if (character === "(") {
      depth += 1;
      continue;
    }
    const closes = character === ")" && depth === 0;
    if (character === ")" && !closes) {
      depth -= 1;
      continue;
    }
    if (!closes && !(character === "," && depth === 0)) {
      continue;
    }
    const begins = nextToken(text, start);
    const definition = text.slice(begins, at).trim();
    if (definition !== "") {
      found.push({ text: definition, at: begins });
    }
    if (closes) {
      return found;
    }
    start = at + 1;
  }
  return null;
}

function readAlterTable(statement: Statement, reading: SchemaReading): void {
  const name = tableNamed(statement.text, STATEMENT_HEADS.alterTable);
  const table = name === null ? undefined : reading.tables.get(name);
  const parsed = parsedOfType(
    parsedStatement(statement.text, reading.grammar),
    "alter",
  );
  if (parsed === null) {
    const column = alteredColumn(statement.text);
    unread(reading, statement.line, name, column);
    forgetDefault(table, column);
    return;
  }
  if (table === undefined) {
    return;
  }
  for (const action of Array.isArray(parsed.expr) ? parsed.expr : []) {
    const node = asNode(action);
    if (node !== null) {
      ALTER_ACTIONS[`${node.action}:${node.resource}`]?.(table, node);
    }
  }
}

/** An unread `ALTER COLUMN` may have given the column a default nothing else states. */
function forgetDefault(
  table: SqlTable | undefined,
  column: string | null,
): void {
  const altered = table?.columns.find((candidate) => candidate.name === column);
  if (altered !== undefined) {
    delete altered.default;
  }
}

const ALTER_ACTIONS: Record<string, (table: SqlTable, action: Node) => void> = {
  "add:constraint": (table, action) => {
    const constraint = asNode(action.create_definitions);
    if (constraint !== null) {
      applyConstraint(table, constraint);
    }
  },
  "alter:column": (table, action) => {
    const name = columnName(asNode(action.column)?.column);
    const change = asNode(action.default_val);
    if (name === null || change === null) {
      return;
    }
    const value = asNode(change.value);
    updateColumn(table, name, {
      default:
        change.type === "set default" && value !== null && !isNullValue(value),
    });
  },
};

const ALTER_COLUMN = /\bALTER\s+COLUMN\s+/i;

/** The column written after `ALTER COLUMN`, read off a statement the grammar rejected. */
function alteredColumn(text: string): string | null {
  const match = ALTER_COLUMN.exec(text);
  if (match === null) {
    return null;
  }
  return writtenNameAt(text, match.index + match[0].length)?.parts[0] ?? null;
}

function unread(
  reading: SchemaReading,
  line: number,
  table: string | null,
  column: string | null,
): void {
  reading.unread.push({ line, table, column });
}
