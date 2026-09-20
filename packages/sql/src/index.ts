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
 * says which dialects it reads and what it leaves out. A spelling the
 * grammar turns down is rewritten and tried again rather than given up.
 */

import bigquery from "node-sql-parser/build/bigquery.js";
import mysql from "node-sql-parser/build/mysql.js";
import postgresql from "node-sql-parser/build/postgresql.js";
import sqlite from "node-sql-parser/build/sqlite.js";

/** One table a statement touches, and what it does to it. */
export interface SqlAccess {
  table: string;
  /**
   * The namespaces the statement put in front of the table, outermost
   * first. BigQuery writes `project.dataset.table`, so a reader that
   * kept the whole string would record a container no provider spells.
   * A part the caller could not settle is left out rather than carried
   * through as a parameter.
   */
  qualifier: string[];
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
 * The dialects this reads, by the name a pack calls its store. Both
 * sides say `postgresql` now, so the second spelling this kept for
 * Postgres is gone.
 */
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

/** Every table a statement touches, or nothing when it cannot be read. */
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
 * Three readings of the same statement, each tried when the one before
 * it came to nothing: as written, with the spellings the grammar turns
 * down rewritten, and with a `WITH` clause the grammar takes only in
 * front of a select split off and read a query at a time.
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

/**
 * What a statement the grammar takes touches, or nothing at all when it
 * turns the statement down. A statement this cannot read says nothing,
 * rather than a guess built out of whatever the text happens to spell.
 */
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

/** What separates the namespaces in front of a table from the table. */
const QUALIFIER_SEPARATOR = ".";

/** A table name, split from the namespaces written in front of it. */
export interface QualifiedTable {
  table: string;
  /** The namespaces in front of the table, outermost first. */
  qualifier: string[];
}

/**
 * A table split from the namespaces written in front of it, or nothing
 * when the table itself came through as a parameter. A pack that reads
 * a table off an argument splits it through here too, so it agrees with
 * a table read out of a statement. The README says more.
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
 * The namespaces a reader can stand behind, read from the table
 * outward. A part nothing settled leaves everything further out
 * unplaceable: the part beside the table is the one a scope is read
 * from, so a project read as though it were a dataset would put the
 * access somewhere it never went.
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

/** One parsed access, with its table split the same way. */
function qualified(access: SqlAccess): SqlAccess | null {
  const split = splitQualifiedTable(access.table);
  return split === null ? null : { ...access, ...split };
}

/**
 * Whether a piece of a name says anything. A hole the caller could not
 * settle comes through `sqlFromParts` as `$1`, and the parse cannot
 * tell that from a name somebody chose.
 */
function isSettled(part: string): boolean {
  return part !== "" && !/^\$\d+$/.test(part);
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
 * The words a statement writes a table's name after, and nothing else.
 * Postgres code leaves a table unquoted nearly every time, so the quote
 * alone would miss the commonest way a project interpolates one.
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

/** The run of text a statement opens at `index`, or nothing for code. */
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
 * Which characters the grammar reads as code. A rewrite that ran over a
 * literal, a quoted name or a comment would change what the statement
 * says rather than how it is spelled.
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

/** How wide or how precise a type is, which some types state. */
const TYPE_SIZE = String.raw`(?:\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?`;

/** The types whose name the standard spells as more than one word. */
const TYPE_TAIL = String.raw`(?:\s+(?:precision|varying|with(?:out)?\s+time\s+zone))?`;

/** A type a statement can cast to, however many dimensions it has. */
const CAST_TYPE =
  `${TYPE_WORD}(?:\\s*\\.\\s*${TYPE_WORD})?` +
  `${TYPE_SIZE}${TYPE_TAIL}${TYPE_SIZE}(?:\\s*\\[\\s*\\])*`;

/** A parameter written with the type the statement reads it as. */
const PARAMETER_CAST = new RegExp(
  String.raw`(\$\d+)(?:\s*::\s*${CAST_TYPE})+`,
  "gi",
);

/** What a statement says it does to the rows a select picks out. */
const LOCKING_CLAUSE = new RegExp(
  String.raw`\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)` +
    String.raw`(?:\s+of\s+${TYPE_WORD}(?:\s*,\s*${TYPE_WORD})*)?` +
    String.raw`(?:\s+(?:nowait|skip\s+locked))?`,
  "gi",
);

/**
 * The same statement in the spellings the grammar takes. A cast on a
 * parameter and a locking clause both say nothing about which table is
 * touched, and the grammar turns down either one.
 */
function rewrittenForGrammar(sql: string): string {
  const uncast = replaceInCode(sql, PARAMETER_CAST, castAwayFrom);
  return replaceInCode(uncast, LOCKING_CLAUSE, nothing);
}

/** The parameter a cast was written on, without the cast. */
function castAwayFrom(match: RegExpMatchArray): string {
  return match[1] ?? "";
}

/** What a clause the statement is read without comes back as. */
function nothing(): string {
  return "";
}

/** One query a `WITH` clause states, and the name it gives it. */
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
 * What a statement led by a `WITH` clause touches, read a query at a
 * time. The grammar takes such a clause only in front of a select, so
 * for anything else the parts are the most that can be read.
 */
function accessesAroundWith(sql: string, grammar: Grammar): SqlAccess[] {
  const split = splitWith(sql);
  if (split === null) {
    return [];
  }
  const names = new Set<string>();
  const inside: SqlAccess[] = [];
  for (const table of split.tables) {
    // A query in a `WITH` can read a sibling stated before it, so the
    // names go in as each one is read.
    inside.push(...(parsedAccesses(table.body, grammar, names) ?? []));
    names.add(table.name);
  }
  const own = parsedAccesses(split.main, grammar, names) ?? [];
  return [...own, ...inside];
}

/** The queries a `WITH` clause states, or nothing when it states none. */
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

/** Where a `WITH` clause goes on after a column list, if it wrote one. */
function afterColumnList(sql: string, mask: boolean[], index: number): number {
  if (sql[index] !== "(") {
    return index;
  }
  const end = afterGroup(sql, mask, index);
  return end === null ? -1 : nextToken(sql, end);
}

/** Where a `WITH` clause goes on after saying how it is evaluated. */
function pastMaterialized(sql: string, index: number): number {
  const past = wordAt(sql, index, "not") ? pastWord(sql, index, "not") : index;
  return wordAt(sql, past, "materialized")
    ? pastWord(sql, past, "materialized")
    : past;
}

/** Where the next thing the grammar reads begins, past blanks and comments. */
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

/** Whether the statement writes `word` at `index`, on its own. */
function wordAt(sql: string, index: number, word: string): boolean {
  const written = sql.slice(index, index + word.length).toLowerCase();
  return written === word && !/\w/.test(sql[index + word.length] ?? "");
}

/** Where the statement goes on after a word it writes at `index`. */
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
 * `defined` is every name a `WITH` clause above this one states, since
 * a query inside one can read from a sibling and that is a name rather
 * than a table.
 */
function accessesIn(statement: unknown, defined: Set<string>): SqlAccess[] {
  const node = asNode(statement);
  if (node === null) {
    return [];
  }
  // A write can carry a `WITH` as readily as a select can, so the clause
  // is read before the statement whatever the statement turns out to be.
  const clause = commonTables(node, defined);
  return [...ownAccesses(node, clause.names), ...clause.inside];
}

/** What the statement itself touches, leaving its `WITH` clause aside. */
function ownAccesses(node: Node, defined: Set<string>): SqlAccess[] {
  if (node.type === "select") {
    return selectAccesses(node, defined);
  }
  if (node.type === "insert") {
    return oneAccess(firstTable(node.table), defined, {
      kind: "write",
      fields: namesOf(node.columns),
      selector: [],
    });
  }
  if (node.type === "update") {
    return oneAccess(firstTable(node.table), defined, {
      kind: "write",
      fields: refsIn(node.set).map((ref) => ref.field),
      selector: selectorFields(node.where),
    });
  }
  if (node.type === "delete") {
    return oneAccess(deletedTable(node), defined, {
      kind: "write",
      fields: [],
      selector: selectorFields(node.where),
    });
  }
  return [];
}

/** The tables a `WITH` clause reads, and the names it gives its queries. */
interface CommonTables {
  names: Set<string>;
  inside: SqlAccess[];
}

/**
 * A `WITH` clause states its own queries and gives each a name the rest
 * of the statement reads from. The tables are inside the clause, and the
 * names themselves are not tables at all.
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
    // A query in a `WITH` can read a sibling stated before it, so the
    // names go in as each one is read.
    inside.push(...accessesIn(cte.stmt, names));
    names.add(name);
  }
  return { names, inside };
}

/**
 * The table a `DELETE` removes rows from. The BigQuery grammar reads the
 * `FROM` keyword itself as the table and leaves the name in the alias, so
 * the alias is the answer wherever that happened.
 */
function deletedTable(node: Node): string | null {
  const first = asNode(Array.isArray(node.table) ? node.table[0] : null);
  const aliased = first === null ? null : stringOf(first.as);
  if (first !== null && stringOf(first.table) === "FROM" && aliased !== null) {
    return aliased;
  }
  return firstTable(node.from) ?? firstTable(node.table);
}

/** A statement whose table this could not read touches nothing. */
function oneAccess(
  table: string | null,
  defined: Set<string>,
  rest: Omit<SqlAccess, "table" | "qualifier">,
): SqlAccess[] {
  return table === null || defined.has(table)
    ? []
    : [{ table, qualifier: [], ...rest }];
}

/**
 * A select reads every table its `FROM` states. A column says which
 * table it belongs to when the query qualifies it, and one that is not
 * qualified belongs to the only table there is. In a join nothing can
 * settle which table an unqualified column comes from, so it is left
 * out rather than attributed to all of them.
 */
function selectAccesses(statement: Node, names: Set<string>): SqlAccess[] {
  const sources = sourcesIn(statement.from, names);
  const tables = sources.tables;
  if (tables.size === 0) {
    return sources.inside;
  }
  const named = [...new Set(tables.values())];
  const only =
    named.length === 1 && !sources.derived ? (named[0] ?? null) : null;
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
      qualifier: [],
      kind: "read" as const,
      fields: [...(fields.get(table) ?? [])],
      selector: [...(selectors.get(table) ?? [])],
    }));
  return [...own, ...sources.inside];
}

/** Everything a `FROM` reads from, a table or a query written in place. */
interface FromSources {
  /** The tables, by every name the rest of the statement can use. */
  tables: Map<string, string>;
  /** What a query written in place of a table reads. */
  inside: SqlAccess[];
  /**
   * Whether the `FROM` reads from something no name in `tables` covers.
   * A column nothing qualifies could belong to that instead, so nothing
   * settles which table such a column comes from.
   */
  derived: boolean;
}

/**
 * The tables a `FROM` states, by every name the rest of the statement
 * can call them: their own, and the alias when the query gives one. A
 * query written in place of a table is read for its own tables instead.
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
      // The alias belongs to the query's own columns, so it goes into no
      // name a column can be attributed through.
      const query = derivedQuery(node);
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

/** The query a `FROM` writes in place of a table, or nothing. */
function derivedQuery(node: Node): unknown {
  const expr = asNode(node.expr);
  if (expr === null) {
    return null;
  }
  return expr.ast ?? expr;
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
