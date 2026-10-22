/**
 * Reads the tables Rails' `db/schema.rb` declares. The file is Ruby, so
 * the Ruby adapter's parser reads it, and nothing in it runs. A table is
 * what one `create_table` call says: its options, each `t.<type>` call in
 * its block, and the foreign keys `add_foreign_key` gives it afterwards.
 * Every column states its nullability and whether the database fills it.
 */

import {
  booleanLiteralValue,
  children,
  field,
  hashKeySymbolName,
  parseRubySync,
  type RbNode,
  singularize,
  stringLiteralValue,
  symbolValue,
} from "@suss/adapter-ruby";

import type { ContractField, DumpTable } from "./table.js";

/** A foreign key stated apart from its column, settled once every table is read. */
interface PendingForeignKey {
  table: string;
  column: string;
  /**
   * The table it points at, or null for `t.references "order",
   * foreign_key: true`, which points at the table named for `reference`.
   */
  to: string | null;
  reference: string;
}

interface SchemaReading {
  tables: DumpTable[];
  foreignKeys: PendingForeignKey[];
}

type Options = Map<string, RbNode>;

interface Args {
  positional: RbNode[];
  keyword: Options;
}

/** The tables a schema.rb declares. The caller loads the Ruby grammar first. */
export function tablesInSchemaRb(source: string): DumpTable[] {
  const reading: SchemaReading = { tables: [], foreignKeys: [] };
  readCalls(parseRubySync(source).rootNode, reading);
  for (const key of reading.foreignKeys) {
    applyForeignKey(key, reading.tables);
  }
  return reading.tables;
}

const SCHEMA_CALLS: Record<
  string,
  (call: RbNode, reading: SchemaReading) => void
> = {
  create_table: readCreateTable,
  add_foreign_key: readAddForeignKey,
};

/** Every call the schema makes, at any depth, since `ActiveRecord::Schema.define` wraps them in a block. */
function readCalls(node: RbNode, reading: SchemaReading): void {
  for (const child of children(node)) {
    const reader =
      child.type === "call" && field(child, "receiver") === null
        ? ownEntry(SCHEMA_CALLS, field(child, "method")?.text)
        : undefined;
    if (reader !== undefined) {
      reader(child, reading);
      continue;
    }
    readCalls(child, reading);
  }
}

/** A table's own entry, so a method such as `constructor` finds nothing. */
function ownEntry<T>(
  table: Record<string, T>,
  key: string | undefined,
): T | undefined {
  return key !== undefined && Object.hasOwn(table, key)
    ? table[key]
    : undefined;
}

function readCreateTable(call: RbNode, reading: SchemaReading): void {
  const args = argsOf(call);
  const name = wordOf(args.positional[0]);
  if (name === null) {
    return;
  }
  const table: DumpTable = {
    name,
    start: call.startPosition.row + 1,
    end: call.endPosition.row + 1,
    columns: implicitKey(args.keyword),
  };
  const block = field(call, "block");
  const builder = builderName(block);
  for (const statement of children(
    block === null ? null : field(block, "body"),
  )) {
    readColumnCall(statement, builder, table, reading);
  }
  markCompositeKey(table, args.keyword.get("primary_key"));
  reading.tables.push(table);
}

/** What the block calls its argument, `t` in every dump Rails writes. */
function builderName(block: RbNode | null): string {
  const parameters = block === null ? null : field(block, "parameters");
  return children(parameters)[0]?.text ?? "t";
}

/** Key types that draw on a sequence unless the dump writes `default: nil`. */
const SEQUENCE_KEY_TYPES = new Set([
  "integer",
  "bigint",
  "serial",
  "bigserial",
  "primary_key",
]);

/**
 * The key `create_table` adds unless `id: false` says not to. With no
 * `id:` it is a `bigint` drawing on a sequence. `primary_key: [...]`
 * makes a composite key out of columns the block declares.
 */
function implicitKey(options: Options): ContractField[] {
  const key = options.get("primary_key");
  const id = options.get("id");
  if (
    key?.type === "array" ||
    (id !== undefined && booleanLiteralValue(id) === false)
  ) {
    return [];
  }
  const type = idType(id);
  return [
    {
      name: wordOf(key) ?? "id",
      type: type ?? "bigint",
      nullable: false,
      primary: true,
      default: keyDefault(type, options.get("default")),
    },
  ];
}

/** The type `id:` gives the key, as a symbol or under `type:` in a hash, or null when unstated. */
function idType(id: RbNode | undefined): string | null {
  if (id?.type === "hash") {
    return wordOf(optionsOf(children(id)).get("type"));
  }
  return wordOf(id);
}

function keyDefault(type: string | null, written: RbNode | undefined): boolean {
  if (written !== undefined) {
    return written.type !== "nil";
  }
  return type === null || SEQUENCE_KEY_TYPES.has(type);
}

function markCompositeKey(table: DumpTable, key: RbNode | undefined): void {
  if (key?.type !== "array") {
    return;
  }
  const columns = new Set(children(key).map(wordOf));
  for (const column of table.columns) {
    if (columns.has(column.name)) {
      column.primary = true;
    }
  }
}

type ColumnCall = (
  args: Args,
  table: DumpTable,
  reading: SchemaReading,
) => void;

/** Calls in a `create_table` block that are not a column of the type they are named for. */
const COLUMN_CALLS: Record<string, ColumnCall> = {
  references: readReferences,
  belongs_to: readReferences,
  timestamps: readTimestamps,
  virtual: readVirtual,
  column: readColumn,
  primary_key: readPrimaryKey,
  index: declaresNoColumn,
  check_constraint: declaresNoColumn,
  exclusion_constraint: declaresNoColumn,
  unique_constraint: declaresNoColumn,
  foreign_key: declaresNoColumn,
};

function readColumnCall(
  statement: RbNode,
  builder: string,
  table: DumpTable,
  reading: SchemaReading,
): void {
  if (
    statement.type !== "call" ||
    field(statement, "receiver")?.text !== builder
  ) {
    return;
  }
  const method = field(statement, "method")?.text;
  if (method === undefined) {
    return;
  }
  const args = argsOf(statement);
  const reader = ownEntry(COLUMN_CALLS, method);
  if (reader !== undefined) {
    reader(args, table, reading);
    return;
  }
  for (const name of namesIn(args)) {
    table.columns.push(typedColumn(name, method, args.keyword));
  }
}

function declaresNoColumn(): void {}

function typedColumn(
  name: string,
  type: string,
  options: Options,
): ContractField {
  const primary = booleanOption(options, "primary_key") === true;
  return {
    name,
    type: columnType(type, options),
    nullable: !primary && booleanOption(options, "null") !== false,
    ...(primary ? { primary: true } : {}),
    default: databaseDefault(options),
  };
}

/**
 * Rails writes a two-byte or eight-byte integer as `t.integer` with a
 * `limit:`. Any other limit means a different type on each engine.
 */
const INTEGER_OF_LIMIT: Record<number, string> = {
  2: "smallint",
  4: "integer",
  5: "bigint",
  6: "bigint",
  7: "bigint",
  8: "bigint",
};

function columnType(type: string, options: Options): string {
  const element =
    type === "integer" ? integerOfLimit(options.get("limit")) : type;
  return booleanOption(options, "array") === true ? `${element}[]` : element;
}

function integerOfLimit(limit: RbNode | undefined): string {
  const bytes = limit === undefined ? null : integerValue(limit);
  if (bytes === null) {
    return "integer";
  }
  return INTEGER_OF_LIMIT[bytes] ?? `integer limit ${bytes}`;
}

/** `default: nil` is how a dump says a column has none. */
function databaseDefault(options: Options): boolean {
  const written = options.get("default");
  return written !== undefined && written.type !== "nil";
}

/**
 * `t.references "order"` is the column `order_id`, a `bigint` unless
 * `type:` says otherwise, and `polymorphic: true` adds `order_type`.
 */
function readReferences(
  args: Args,
  table: DumpTable,
  reading: SchemaReading,
): void {
  const options = args.keyword;
  const nullable = booleanOption(options, "null") !== false;
  for (const name of namesIn(args)) {
    const column = `${name}_id`;
    table.columns.push({
      name: column,
      type: wordOf(options.get("type")) ?? "bigint",
      nullable,
      default: databaseDefault(options),
    });
    if (booleanOption(options, "polymorphic") === true) {
      table.columns.push({
        name: `${name}_type`,
        type: "string",
        nullable,
        default: false,
      });
    }
    const target = referenceTarget(options.get("foreign_key"));
    if (target !== undefined) {
      reading.foreignKeys.push({
        table: table.name,
        column,
        to: target,
        reference: name,
      });
    }
  }
}

/**
 * The table `foreign_key:` points a reference at: the one `to_table:`
 * gives, or null for the table named for the reference. Undefined when
 * the reference has no foreign key.
 */
function referenceTarget(
  option: RbNode | undefined,
): string | null | undefined {
  if (option === undefined || booleanLiteralValue(option) === false) {
    return undefined;
  }
  if (option.type !== "hash") {
    return null;
  }
  return wordOf(optionsOf(children(option)).get("to_table"));
}

/** Since Rails 5, both timestamps are NOT NULL unless `null: true` says otherwise. */
function readTimestamps(args: Args, table: DumpTable): void {
  const nullable = booleanOption(args.keyword, "null") === true;
  for (const name of ["created_at", "updated_at"]) {
    table.columns.push({
      name,
      type: "datetime",
      nullable,
      default: databaseDefault(args.keyword),
    });
  }
}

/** A generated column, which the database computes and no insert writes. */
function readVirtual(args: Args, table: DumpTable): void {
  for (const name of namesIn(args)) {
    table.columns.push({
      name,
      type: wordOf(args.keyword.get("type")) ?? "virtual",
      nullable: booleanOption(args.keyword, "null") !== false,
      default: true,
      derived: true,
    });
  }
}

/** `t.column "name", :type`. */
function readColumn(args: Args, table: DumpTable): void {
  const name = wordOf(args.positional[0]);
  const type = wordOf(args.positional[1]);
  if (name !== null && type !== null) {
    table.columns.push(typedColumn(name, type, args.keyword));
  }
}

/** `t.primary_key "id", :uuid`, with the type of an implicit key when none is given. */
function readPrimaryKey(args: Args, table: DumpTable): void {
  const name = wordOf(args.positional[0]);
  if (name === null) {
    return;
  }
  const type = wordOf(args.positional[1]);
  table.columns.push({
    name,
    type: type ?? "bigint",
    nullable: false,
    primary: true,
    default: keyDefault(type, args.keyword.get("default")),
  });
}

/** `add_foreign_key "orders", "users"` is on `user_id` unless `column:` says which. */
function readAddForeignKey(call: RbNode, reading: SchemaReading): void {
  const args = argsOf(call);
  const table = wordOf(args.positional[0]);
  const to = wordOf(args.positional[1]);
  if (table === null || to === null) {
    return;
  }
  reading.foreignKeys.push({
    table,
    column:
      wordOf(args.keyword.get("column")) ??
      `${singularize(unqualified(to))}_id`,
    to,
    reference: to,
  });
}

function applyForeignKey(key: PendingForeignKey, tables: DumpTable[]): void {
  const target = key.to ?? tableNamedFor(key.reference, tables);
  const column = tables
    .find((table) => table.name === key.table)
    ?.columns.find((candidate) => candidate.name === key.column);
  if (target !== null && column !== undefined) {
    column.foreignKey = target;
  }
}

/** The declared table whose name is the plural of a reference's, as Rails pluralizes it. */
function tableNamedFor(reference: string, tables: DumpTable[]): string | null {
  const table = tables.find(
    (candidate) => singularize(unqualified(candidate.name)) === reference,
  );
  return table?.name ?? null;
}

function unqualified(table: string): string {
  return table.slice(table.lastIndexOf(".") + 1);
}

function argsOf(call: RbNode): Args {
  const nodes = children(field(call, "arguments"));
  return {
    positional: nodes.filter((node) => node.type !== "pair"),
    keyword: optionsOf(nodes),
  };
}

/** The pairs among `nodes`, written `key: value` or, in an older dump, `:key => value`. */
function optionsOf(nodes: RbNode[]): Options {
  const options: Options = new Map();
  for (const pair of nodes) {
    const key = pair.type === "pair" ? field(pair, "key") : null;
    const value = pair.type === "pair" ? field(pair, "value") : null;
    const name =
      key === null
        ? null
        : (hashKeySymbolName(key) ??
          symbolValue(key) ??
          stringLiteralValue(key));
    if (name !== null && value !== null) {
      options.set(name, value);
    }
  }
  return options;
}

/** A name or a type, written as a string or a symbol. */
function wordOf(node: RbNode | undefined): string | null {
  if (node === undefined) {
    return null;
  }
  return symbolValue(node) ?? stringLiteralValue(node);
}

function namesIn(args: Args): string[] {
  return args.positional
    .map(wordOf)
    .filter((name): name is string => name !== null);
}

function booleanOption(options: Options, key: string): boolean | null {
  const node = options.get(key);
  return node === undefined ? null : booleanLiteralValue(node);
}

function integerValue(node: RbNode): number | null {
  return node.type === "integer"
    ? Number.parseInt(node.text.replace(/_/g, ""), 10)
    : null;
}
