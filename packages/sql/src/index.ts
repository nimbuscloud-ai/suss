/**
 * Reads what a SQL statement touches: which tables, which fields, and
 * what it picks rows by.
 *
 * A pack that finds a query written as SQL instead of through an ORM
 * passes the text here and gets back the same `SqlAccess` records its
 * own recognizer would have produced. The statement is parsed with a
 * grammar, so a join contributes every table it reads and a `WHERE`
 * contributes a selector.
 *
 * A statement the grammar rejects is rewritten and tried again. If it
 * still fails the result is empty, and nothing is guessed from the
 * words in the text. The README lists the dialects and what is left out.
 */

import bigquery from "node-sql-parser/build/bigquery.js";
import mysql from "node-sql-parser/build/mysql.js";
import postgresql from "node-sql-parser/build/postgresql.js";
import sqlite from "node-sql-parser/build/sqlite.js";

/** One table a statement touches, and what it does to it. */
export interface SqlAccess {
  table: string;
  /**
   * The namespaces written in front of the table, outermost first.
   * BigQuery writes `project.dataset.table`, and keeping the whole
   * string as the table would record a name no provider declares. A
   * part the caller could not resolve, and every part outside it, is
   * left out.
   */
  qualifier: string[];
  kind: "read" | "write";
  /** The fields the statement lists, or `["*"]` for a whole row. */
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

/** The grammars, keyed by the store name a pack declares. */
const DIALECTS: Record<string, Grammar> = {
  postgresql: { module: postgresql as ParserModule, database: "postgresql" },
  mysql: { module: mysql as ParserModule, database: "mysql" },
  sqlite: { module: sqlite as ParserModule, database: "sqlite" },
  bigquery: { module: bigquery as ParserModule, database: "bigquery" },
};

interface Grammar {
  module: ParserModule;
  database: string;
}

/** Every table a statement touches. Empty when the dialect is unknown or the statement cannot be parsed. */
export function readSqlAccess(
  sql: string,
  options: SqlReadOptions = {},
): SqlAccess[] {
  const grammar = DIALECTS[options.dialect ?? "postgresql"];
  if (grammar === undefined) {
    return [];
  }
  return accessesInSql(sql, grammar)
    .map(qualified)
    .filter((access): access is SqlAccess => access !== null);
}

/**
 * Tries three readings of the statement, each only when the one before
 * it fails to parse: first as written, then with the spellings the
 * grammar rejects rewritten, then with a leading `WITH` clause split
 * off so each query is parsed on its own.
 */
function accessesInSql(sql: string, grammar: Grammar): SqlAccess[] {
  const written = parsedAccesses(sql, grammar);
  if (written !== null) {
    return written;
  }
  const readable = rewrittenForGrammar(sql);
  const rewritten = readable === sql ? null : parsedAccesses(readable, grammar);
  return rewritten ?? accessesAroundWith(readable, grammar);
}

/** The accesses in a statement, or null when the grammar rejects it and the caller should try another reading. */
function parsedAccesses(
  sql: string,
  grammar: Grammar,
  defined: Set<string> = new Set(),
): SqlAccess[] | null {
  let parsed: unknown;
  try {
    parsed = new grammar.module.Parser().astify(sql, {
      database: grammar.database,
    });
  } catch {
    return null;
  }
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  return statements.flatMap((statement) => accessesIn(statement, defined));
}

const QUALIFIER_SEPARATOR = ".";

/** A table name, split from the namespaces written in front of it. */
export interface QualifiedTable {
  table: string;
  /** The namespaces in front of the table, outermost first. */
  qualifier: string[];
}

/**
 * Splits a table name from the namespaces written in front of it.
 * Returns null when the table itself came through as a parameter. A
 * pack that reads a table off a call's argument splits it here too, so
 * the result matches the same table read out of a statement.
 */
export function splitQualifiedTable(name: string): QualifiedTable | null {
  const parts = name.split(QUALIFIER_SEPARATOR);
  const table = parts[parts.length - 1] ?? name;
  if (!isSettled(table)) {
    return null;
  }
  return { table, qualifier: namespacesAround(parts.slice(0, -1)) };
}

/**
 * The namespaces in front of a table, read from the table outward and
 * stopping at the first part that is empty or a parameter. The part
 * next to the table is the one a scope comes from, so reading a project
 * as if it were a dataset would record the access in the wrong place.
 */
function namespacesAround(namespaces: readonly string[]): string[] {
  const found: string[] = [];
  for (let index = namespaces.length - 1; index >= 0; index -= 1) {
    const part = namespaces[index];
    if (part === undefined || !isSettled(part)) {
      break;
    }
    found.unshift(part);
  }
  return found;
}

/** One parsed access, with its table split from its namespaces. */
function qualified(access: SqlAccess): SqlAccess | null {
  const split = splitQualifiedTable(access.table);
  return split === null ? null : { ...access, ...split };
}

/**
 * Whether a part of a name is known. A hole the caller could not
 * resolve comes out of `sqlFromParts` as `$1`, and the parser accepts
 * that as an ordinary name.
 */
function isSettled(part: string): boolean {
  return part !== "" && !/^\$\d+$/.test(part);
}

/**
 * Joins a tagged template's parts into SQL, writing each interpolation
 * as a parameter (`$1`, `$2`). A query interpolates a value nearly every
 * time, and a parameter is how the statement would pass a value anyway,
 * so the text parses with the meaning it has at run time.
 *
 * `substitutions` replaces a hole wherever it is, for a caller that
 * knows the hole is a table, such as an interpolated schema object.
 * `settled` replaces a hole only where the statement writes a name.
 * Any other hole stays a parameter, and a statement with a parameter
 * where the grammar does not allow one parses to no accesses.
 */
export function sqlFromParts(
  parts: readonly string[],
  substitutions: ReadonlyArray<string | null> = [],
  settled: ReadonlyArray<string | null> = [],
): string {
  let closing: string | null = null;
  return parts
    .map((part, index) => {
      const names = namePosition(closing, parts[index - 1] ?? "");
      const inHole =
        index === 0
          ? null
          : (substitutions[index - 1] ??
            (names ? (settled[index - 1] ?? null) : null));
      closing = quoteAfter(closing, part);
      return index === 0 ? part : `${inHole ?? `$${index}`}${part}`;
    })
    .join("");
}

/**
 * The keywords a table name follows. Postgres code nearly always leaves
 * a table unquoted, so checking for a quote alone would miss most
 * interpolated tables.
 */
const TABLE_KEYWORD = /\b(?:from|join|into|update|table)\s+$/i;

/** Whether the statement writes a name where this hole goes. */
function namePosition(closing: string | null, before: string): boolean {
  return closing !== null || TABLE_KEYWORD.test(before);
}

/** What closes a quoted name, by the character that opened it. */
const NAME_QUOTES: Record<string, string> = { '"': '"', "`": "`", "[": "]" };

/** The quote still open after a piece of a template, or null for none. */
function quoteAfter(open: string | null, part: string): string | null {
  let closing = open;
  for (const character of part) {
    if (closing === null) {
      closing = NAME_QUOTES[character] ?? null;
      continue;
    }
    if (character === closing) {
      closing = null;
    }
  }
  return closing;
}

/** A stretch of a statement the grammar reads as text rather than code. */
interface TextRun {
  /** One character past the end of the run. */
  end: number;
  /** Whether it is a comment rather than a literal or a quoted name. */
  comment: boolean;
}

/** What closes a run of text, by what opened it. */
const TEXT_RUNS: ReadonlyArray<{
  open: string;
  close: string;
  comment: boolean;
}> = [
  { open: "--", close: "\n", comment: true },
  { open: "/*", close: "*/", comment: true },
  { open: "'", close: "'", comment: false },
  { open: '"', close: '"', comment: false },
  { open: "`", close: "`", comment: false },
];

/** What opens and closes a Postgres dollar-quoted literal. */
const DOLLAR_TAG = /\$(?:[A-Za-z_]\w*)?\$/y;

/** The run of text that opens at `index`, or null when `index` is in code. */
function textRunAt(sql: string, index: number): TextRun | null {
  DOLLAR_TAG.lastIndex = index;
  const tag = DOLLAR_TAG.exec(sql)?.[0];
  if (tag !== undefined) {
    return { end: closingAt(sql, index + tag.length, tag), comment: false };
  }
  for (const run of TEXT_RUNS) {
    if (sql.startsWith(run.open, index)) {
      const from = index + run.open.length;
      return { end: closingAt(sql, from, run.close), comment: run.comment };
    }
  }
  return null;
}

/** One character past the closer, or the end when nothing closed it. */
function closingAt(sql: string, from: number, close: string): number {
  const at = sql.indexOf(close, from);
  return at === -1 ? sql.length : at + close.length;
}

/**
 * Which characters are code, as opposed to a literal, a quoted name or
 * a comment. The rewrites apply to code only, because rewriting inside
 * text would change the statement's meaning.
 */
function codeMask(sql: string): boolean[] {
  const mask = new Array<boolean>(sql.length).fill(true);
  let index = 0;
  while (index < sql.length) {
    const run = textRunAt(sql, index);
    if (run === null) {
      index += 1;
      continue;
    }
    for (let at = index; at < run.end; at += 1) {
      mask[at] = false;
    }
    index = run.end;
  }
  return mask;
}

/** The statement with every match that starts in code rewritten. */
function replaceInCode(
  sql: string,
  pattern: RegExp,
  rewrite: (match: RegExpMatchArray) => string,
): string {
  const mask = codeMask(sql);
  let rewritten = "";
  let from = 0;
  for (const match of sql.matchAll(pattern)) {
    const at = match.index;
    if (at === undefined || mask[at] === false) {
      continue;
    }
    rewritten += sql.slice(from, at) + rewrite(match);
    from = at + match[0].length;
  }
  return rewritten + sql.slice(from);
}

/** A name a type can go by, quoted or bare. */
const TYPE_WORD = String.raw`(?:"[^"]*"|\w+)`;

/** The optional length or precision after a type, as in `varchar(20)` or `numeric(10, 2)`. */
const TYPE_SIZE = String.raw`(?:\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?`;

/** The words after a type name the standard writes as more than one word, as in `double precision`. */
const TYPE_TAIL = String.raw`(?:\s+(?:precision|varying|with(?:out)?\s+time\s+zone))?`;

/** A type a statement can cast to, including a schema-qualified name and array dimensions. */
const CAST_TYPE =
  `${TYPE_WORD}(?:\\s*\\.\\s*${TYPE_WORD})?` +
  `${TYPE_SIZE}${TYPE_TAIL}${TYPE_SIZE}(?:\\s*\\[\\s*\\])*`;

/** A parameter with a cast, such as `$1::text`. */
const PARAMETER_CAST = new RegExp(
  String.raw`(\$\d+)(?:\s*::\s*${CAST_TYPE})+`,
  "gi",
);

/** A row-locking clause on a select, such as `FOR UPDATE SKIP LOCKED`. */
const LOCKING_CLAUSE = new RegExp(
  String.raw`\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)` +
    String.raw`(?:\s+of\s+${TYPE_WORD}(?:\s*,\s*${TYPE_WORD})*)?` +
    String.raw`(?:\s+(?:nowait|skip\s+locked))?`,
  "gi",
);

/**
 * The statement with parameter casts and locking clauses removed. The
 * grammar rejects both, and neither affects which tables are touched.
 */
function rewrittenForGrammar(sql: string): string {
  const uncast = replaceInCode(sql, PARAMETER_CAST, castAwayFrom);
  return replaceInCode(uncast, LOCKING_CLAUSE, nothing);
}

/** The parameter a cast was written on, without the cast. */
function castAwayFrom(match: RegExpMatchArray): string {
  return match[1] ?? "";
}

/** The replacement for a clause that is removed. */
function nothing(): string {
  return "";
}

/** One query in a `WITH` clause, and its name. */
interface CommonTable {
  name: string;
  body: string;
}

/** A `WITH` clause, split from the statement that comes after it. */
interface SplitWith {
  tables: CommonTable[];
  main: string;
}

/**
 * The accesses in a statement that starts with a `WITH` clause, parsed
 * one query at a time. The grammar accepts the clause only in front of
 * a select, so for an insert, update or delete the separate parts are
 * all that can be parsed.
 */
function accessesAroundWith(sql: string, grammar: Grammar): SqlAccess[] {
  const split = splitWith(sql);
  if (split === null) {
    return [];
  }
  const names = new Set<string>();
  const inside: SqlAccess[] = [];
  for (const table of split.tables) {
    // A query in a `WITH` can read from a sibling defined before it, so
    // each name is added after its own query is read.
    inside.push(...(parsedAccesses(table.body, grammar, names) ?? []));
    names.add(table.name);
  }
  const own = parsedAccesses(split.main, grammar, names) ?? [];
  return [...own, ...inside];
}

/** The queries in a leading `WITH` clause and the statement after it, or null when there is no such clause or it does not parse. */
function splitWith(sql: string): SplitWith | null {
  const mask = codeMask(sql);
  let index = nextToken(sql, 0);
  if (!wordAt(sql, index, "with")) {
    return null;
  }
  index = pastWord(sql, index, "with");
  if (wordAt(sql, index, "recursive")) {
    index = pastWord(sql, index, "recursive");
  }
  const tables: CommonTable[] = [];
  for (;;) {
    const named = nameAt(sql, index);
    if (named === null) {
      return null;
    }
    index = afterColumnList(sql, mask, nextToken(sql, named.end));
    if (index === -1 || !wordAt(sql, index, "as")) {
      return null;
    }
    index = pastMaterialized(sql, pastWord(sql, index, "as"));
    const end = afterGroup(sql, mask, index);
    if (end === null) {
      return null;
    }
    tables.push({ name: named.name, body: sql.slice(index + 1, end - 1) });
    index = nextToken(sql, end);
    if (sql[index] !== ",") {
      return { tables, main: sql.slice(index) };
    }
    index = nextToken(sql, index + 1);
  }
}

/** The index past a query's optional column list, or -1 when the list is not closed. */
function afterColumnList(sql: string, mask: boolean[], index: number): number {
  if (sql[index] !== "(") {
    return index;
  }
  const end = afterGroup(sql, mask, index);
  return end === null ? -1 : nextToken(sql, end);
}

/** The index past an optional `MATERIALIZED` or `NOT MATERIALIZED`. */
function pastMaterialized(sql: string, index: number): number {
  const past = wordAt(sql, index, "not") ? pastWord(sql, index, "not") : index;
  return wordAt(sql, past, "materialized")
    ? pastWord(sql, past, "materialized")
    : past;
}

/** The index of the next token, past whitespace and comments. */
function nextToken(sql: string, from: number): number {
  let index = from;
  while (index < sql.length) {
    if (/\s/.test(sql[index] ?? "")) {
      index += 1;
      continue;
    }
    const run = textRunAt(sql, index);
    if (run === null || !run.comment) {
      return index;
    }
    index = run.end;
  }
  return index;
}

/** Whether `word` appears at `index` as a whole word, ignoring case. */
function wordAt(sql: string, index: number, word: string): boolean {
  const written = sql.slice(index, index + word.length).toLowerCase();
  return written === word && !/\w/.test(sql[index + word.length] ?? "");
}

/** The index of the next token after `word` at `index`. */
function pastWord(sql: string, index: number, word: string): number {
  return nextToken(sql, index + word.length);
}

/** The name a `WITH` clause gives a query, and where it ends. */
function nameAt(
  sql: string,
  index: number,
): { name: string; end: number } | null {
  if (sql[index] === '"') {
    const close = sql.indexOf('"', index + 1);
    return close === -1
      ? null
      : { name: sql.slice(index + 1, close), end: close + 1 };
  }
  const word = /^\w+/.exec(sql.slice(index))?.[0];
  return word === undefined ? null : { name: word, end: index + word.length };
}

/** One character past the parenthesis group opened at `index`. */
function afterGroup(
  sql: string,
  mask: boolean[],
  index: number,
): number | null {
  if (sql[index] !== "(" || mask[index] === false) {
    return null;
  }
  let depth = 0;
  for (let at = index; at < sql.length; at += 1) {
    if (mask[at] === false) {
      continue;
    }
    if (sql[at] === "(") {
      depth += 1;
      continue;
    }
    if (sql[at] !== ")") {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return at + 1;
    }
  }
  return null;
}

interface Node {
  type?: string;
  [key: string]: unknown;
}

/**
 * `defined` contains every query name from an enclosing `WITH` clause. A
 * read of one of those names is a read of that query, so it is not
 * reported as a table.
 */
function accessesIn(statement: unknown, defined: Set<string>): SqlAccess[] {
  const node = asNode(statement);
  if (node === null) {
    return [];
  }
  // An insert, update or delete can start with a `WITH` as well as a
  // select, so the clause is read before looking at the statement type.
  const clause = commonTables(node, defined);
  return [...ownAccesses(node, clause.names), ...clause.inside];
}

/** What the statement itself touches, leaving its `WITH` clause aside. */
function ownAccesses(node: Node, defined: Set<string>): SqlAccess[] {
  if (node.type === "select") {
    // The parser links each branch of a set operation after the first
    // through `_next`, and each branch reads its own tables.
    return [
      ...selectAccesses(node, defined),
      ...accessesIn(node._next, defined),
    ];
  }
  if (node.type === "insert") {
    return insertAccesses(node, defined);
  }
  if (node.type === "update") {
    return updateAccesses(node, defined);
  }
  if (node.type === "delete") {
    return deleteAccesses(node, defined);
  }
  return [];
}

/**
 * An insert writes one table. Its rows can come from a query instead of
 * a list of values, and that query is read as a separate statement for
 * the tables it reads.
 */
function insertAccesses(node: Node, defined: Set<string>): SqlAccess[] {
  const conflict = conflictClauses(node);
  const stated: Stated = {
    fields: [
      ...unqualified(namesOf(node.columns)),
      ...refsIn(node.returning),
      ...conflict.fields,
    ],
    selector: conflict.selector,
  };
  const sources = sourcesIn(node.table, defined);
  return [
    ...accessesAcross(sources, firstTable(node.table), stated, defined),
    ...accessesIn(node.values, defined),
  ];
}

/**
 * An update writes its first table and reads the rest. Depending on the
 * grammar, the other tables come in a `FROM` clause or are joined to
 * the table being written.
 */
function updateAccesses(node: Node, defined: Set<string>): SqlAccess[] {
  const sources = sourcesAcross([node.table, node.from], defined);
  const stated: Stated = {
    fields: [...setTargets(node.set), ...refsIn(node.returning)],
    selector: refsIn(node.where),
  };
  return accessesAcross(sources, firstTable(node.table), stated, defined);
}

/**
 * A delete writes the table it removes rows from and reads every other
 * table in its `FROM`.
 */
function deleteAccesses(node: Node, defined: Set<string>): SqlAccess[] {
  const written = deletedTable(node);
  const stated: Stated = {
    fields: refsIn(node.returning),
    selector: refsIn(node.where),
  };
  const sources = withTable(sourcesIn(node.from, defined), written);
  return accessesAcross(sources, written, stated, defined);
}

/**
 * The fields an `ON CONFLICT` clause uses on the table the insert
 * writes: the columns it matches an existing row by and the columns it
 * sets, with its `WHERE` as the selector. The other grammars write the
 * clause as `ON DUPLICATE KEY UPDATE`, which has no condition.
 */
function conflictClauses(node: Node): Stated {
  const conflict = asNode(node.conflict);
  const action = asNode(asNode(conflict?.action)?.expr);
  return {
    fields: [
      ...refsIn(conflict?.target),
      ...setTargets(action?.set),
      ...setTargets(asNode(node.on_duplicate_update)?.set),
    ],
    selector: refsIn(action?.where),
  };
}

/** The tables a `WITH` clause reads, and the names it gives its queries. */
interface CommonTables {
  names: Set<string>;
  inside: SqlAccess[];
}

/**
 * Reads the queries in a `WITH` clause. The tables they read go in
 * `inside`, and each query's name goes in `names` so the rest of the
 * statement does not report it as a table.
 */
function commonTables(node: Node, outer: Set<string>): CommonTables {
  const names = new Set(outer);
  const inside: SqlAccess[] = [];
  for (const entry of Array.isArray(node.with) ? node.with : []) {
    const cte = asNode(entry);
    if (cte === null) {
      continue;
    }
    const name = columnName(cte.name);
    if (name === null) {
      continue;
    }
    // A query in a `WITH` can read from a sibling defined before it, so
    // each name is added after its own query is read.
    inside.push(...accessesIn(statementOf(cte.stmt), names));
    names.add(name);
  }
  return { names, inside };
}

/**
 * The table a `DELETE` removes rows from. The BigQuery grammar reads the
 * `FROM` keyword itself as the table and leaves the name in the alias, so
 * in that case the alias is the table.
 */
function deletedTable(node: Node): string | null {
  const first = asNode(Array.isArray(node.table) ? node.table[0] : null);
  const aliased = first === null ? null : stringOf(first.as);
  if (first !== null && stringOf(first.table) === "FROM" && aliased !== null) {
    return aliased;
  }
  return firstTable(node.from) ?? firstTable(node.table);
}

/** The fields a statement refers to, split into the two lists an access reports. */
interface Stated {
  /** The fields it reads or writes. */
  fields: FieldRef[];
  /** The fields it picks rows by. */
  selector: FieldRef[];
}

/** A select reads every table in its `FROM`. */
function selectAccesses(statement: Node, names: Set<string>): SqlAccess[] {
  const stated: Stated = {
    fields: refsIn(statement.columns),
    selector: refsIn(statement.where),
  };
  return accessesAcross(sourcesIn(statement.from, names), null, stated, names);
}

/**
 * One access per table the statement reads or writes, with each field
 * on the table it is qualified with. An unqualified field goes on the
 * table being written, or else on the only source. An unqualified
 * selector column goes on the only source. When there is more than one
 * source, such a column could come from any of them, so it is left out.
 */
function accessesAcross(
  sources: FromSources,
  written: string | null,
  stated: Stated,
  defined: Set<string>,
): SqlAccess[] {
  const named = [...new Set(sources.tables.values())];
  const only =
    named.length === 1 && !sources.derived ? (named[0] ?? null) : null;
  const fields = byTable(stated.fields, sources.tables, written ?? only);
  const selector = byTable(stated.selector, sources.tables, only);
  const own = named
    .filter((table) => !defined.has(table))
    .map((table) => ({
      table,
      qualifier: [],
      kind: table === written ? ("write" as const) : ("read" as const),
      fields: fields.get(table) ?? [],
      selector: selector.get(table) ?? [],
    }));
  return [...own, ...sources.inside];
}

/**
 * The fields one clause puts on each table, in the order the statement
 * writes them. `only` is the table an unqualified field goes on, or
 * null when that is ambiguous.
 */
function byTable(
  refs: readonly FieldRef[],
  tables: ReadonlyMap<string, string>,
  only: string | null,
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const ref of refs) {
    const table =
      ref.table === undefined ? only : (tables.get(ref.table) ?? null);
    if (table === null) {
      continue;
    }
    const already = found.get(table) ?? [];
    if (!already.includes(ref.field)) {
      already.push(ref.field);
    }
    found.set(table, already);
  }
  return found;
}

/** Everything a `FROM` reads from: tables, and queries written in place of a table. */
interface FromSources {
  /** Each table, keyed by its own name and by its alias. */
  tables: Map<string, string>;
  /** What a query written in place of a table reads. */
  inside: SqlAccess[];
  /**
   * Whether the `FROM` reads from a query written in place of a table.
   * An unqualified column could come from that query, so it cannot be
   * placed on a table.
   */
  derived: boolean;
}

/**
 * The tables in a `FROM`, keyed by their own name and by their alias
 * when there is one. A query written in place of a table is read for
 * its own tables instead.
 */
function sourcesIn(from: unknown, defined: Set<string>): FromSources {
  const tables = new Map<string, string>();
  const inside: SqlAccess[] = [];
  let derived = false;
  for (const entry of Array.isArray(from) ? from : []) {
    const node = asNode(entry);
    if (node === null) {
      continue;
    }
    const table = stringOf(node.table);
    if (table === null) {
      // The alias refers to the query's own columns, so it is left out
      // of `tables`.
      const query = statementOf(node.expr);
      derived = derived || query !== null;
      inside.push(...accessesIn(query, defined));
      continue;
    }
    tables.set(table, table);
    const alias = stringOf(node.as);
    if (alias !== null) {
      tables.set(alias, table);
    }
  }
  return { tables, inside, derived };
}

/**
 * The statement inside a node, past the `ast` wrapper one grammar puts
 * around it. A query written in place of a table and a query in a
 * `WITH` clause can each come with or without the wrapper.
 */
function statementOf(value: unknown): unknown {
  const node = asNode(value);
  if (node === null) {
    return null;
  }
  return node.ast ?? node;
}

/** The sources from several clauses of one statement, merged. */
function sourcesAcross(
  clauses: readonly unknown[],
  defined: Set<string>,
): FromSources {
  const tables = new Map<string, string>();
  const inside: SqlAccess[] = [];
  let derived = false;
  for (const clause of clauses) {
    const found = sourcesIn(clause, defined);
    for (const [name, table] of found.tables) {
      tables.set(name, table);
    }
    inside.push(...found.inside);
    derived = derived || found.derived;
  }
  return { tables, inside, derived };
}

/**
 * Adds the written table to the sources when it is missing. One grammar
 * leaves a delete's table out of the `FROM` it parses, so the table is
 * put first.
 */
function withTable(sources: FromSources, table: string | null): FromSources {
  if (table === null || sources.tables.has(table)) {
    return sources;
  }
  return { ...sources, tables: new Map([[table, table], ...sources.tables]) };
}

function firstTable(value: unknown): string | null {
  return [...sourcesIn(value, new Set()).tables.values()][0] ?? null;
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

/** Fields written without a table. */
function unqualified(names: readonly string[]): FieldRef[] {
  return names.map((field) => ({ table: undefined, field }));
}

/**
 * The field each assignment in a `SET` writes, with its table when the
 * statement qualifies it. One grammar parses an assignment as a column
 * reference with the value attached, and another as a plain column next
 * to its table. Both put `column` and `table` on the entry.
 */
function setTargets(value: unknown): FieldRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const found: FieldRef[] = [];
  for (const entry of value) {
    const node = asNode(entry);
    const field = node === null ? null : columnName(node.column);
    if (node !== null && field !== null) {
      found.push({ table: stringOf(node.table) ?? undefined, field });
    }
  }
  return found;
}

/** The columns an insert lists, which the parser returns without a table. */
function namesOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => columnName(entry))
    .filter((name): name is string => name !== null);
}

/**
 * A column's name. The parser returns a bare name as a string and a
 * quoted or qualified one as a value node.
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
