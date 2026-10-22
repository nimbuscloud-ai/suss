/**
 * Compares two declarations of one database table column by column,
 * such as Rails' `db/schema.rb` and a Drizzle copy of the same tables.
 * Two declared stores are one table on the storage pass's own key, read
 * provider to provider: the engines agree (a null engine meets any),
 * the scopes and access paths are equal, a name of one agrees with a
 * name of the other, and the workspaces agree when both are set.
 *
 * The side that speaks for the database is the provider and the copy is
 * the consumer. When neither side is known to match the database, either
 * could be out of date, so a column or a default on one side only is a
 * warning. The storage README lists every rule with its severity.
 */

import { namesAgree, summaryIdentifier } from "@suss/behavioral-ir";
import { storageLabel } from "@suss/ir-core";

import { makeSide } from "../coverage/responseMatch.js";
import {
  buildInteractionIndex,
  type InteractionIndex,
  providersOf,
} from "../interactions/dispatcher.js";
import {
  type DeclaredContainer,
  declaredContainers,
  sameService,
} from "./storagePairing.js";

import type {
  BehavioralSummary,
  Finding,
  FindingSeverity,
  FindingSide,
  StorageContractMetadata,
  StorageSemantics,
} from "@suss/behavioral-ir";
import type { ComparedPair } from "../pairing/comparedPair.js";

type ContractField = NonNullable<StorageContractMetadata["fields"]>[number];

/** What a column stores, with lengths, precisions and enum values left out. */
type Family =
  | "integer"
  | "smallint"
  | "bigint"
  | "numeric"
  | "float"
  | "text"
  | "boolean"
  | "uuid"
  | "timestamp"
  | "date"
  | "time"
  | "interval"
  | "json"
  | "bytea"
  | "enum"
  | "array";

/**
 * The spellings readers write for each family, compared without case.
 * Time zones, and json against jsonb, are one family for now.
 */
const SPELLINGS: Record<Family, readonly string[]> = {
  integer: ["integer", "int", "int4", "serial", "serial4"],
  smallint: [
    "smallint",
    "int2",
    "smallserial",
    "serial2",
    "smallinteger",
    "@db.smallint",
  ],
  bigint: [
    "bigint",
    "int8",
    "bigserial",
    "serial8",
    "biginteger",
    "@db.bigint",
  ],
  numeric: ["numeric", "decimal", "@db.decimal"],
  float: [
    "float",
    "real",
    "double",
    "doubleprecision",
    "double precision",
    "float4",
    "float8",
    "@db.real",
    "@db.doubleprecision",
  ],
  text: [
    "string",
    "text",
    "varchar",
    "char",
    "character",
    "character varying",
    "bpchar",
    "citext",
    "@db.text",
    "@db.varchar",
    "@db.char",
    "@db.citext",
  ],
  boolean: ["boolean", "bool", "tinyint(1)"],
  uuid: ["uuid", "@db.uuid"],
  timestamp: [
    "datetime",
    "timestamp",
    "timestamptz",
    "timestamp with time zone",
    "timestamp without time zone",
    "@db.timestamp",
    "@db.timestamptz",
  ],
  date: ["date", "@db.date"],
  time: [
    "time",
    "timetz",
    "time with time zone",
    "time without time zone",
    "@db.time",
    "@db.timetz",
  ],
  interval: ["interval"],
  json: ["json", "jsonb", "@db.json", "@db.jsonb"],
  bytea: ["binary", "bytea", "bytes", "largebinary", "@db.bytea"],
  enum: ["enum"],
  array: ["array"],
};

const FAMILY_OF = new Map<string, Family>(
  (Object.entries(SPELLINGS) as Array<[Family, readonly string[]]>).flatMap(
    ([family, spellings]) =>
      spellings.map((spelling): [string, Family] => [spelling, family]),
  ),
);

/** An array is one family whatever its elements are. */
function familyOf(type: string): Family | undefined {
  if (type.endsWith("[]")) {
    return "array";
  }
  return FAMILY_OF.get(type.toLowerCase());
}

/** A column the pass could not compare, and why. */
export interface UncheckedColumn {
  /** The table's label, such as `postgresql:attachments`. */
  boundary: string;
  provider: string;
  consumer: string;
  /** Null when the whole table went unchecked. */
  column: string | null;
  reason: string;
}

export interface SchemaAgreement {
  findings: Finding[];
  unchecked: UncheckedColumn[];
}

/**
 * Pair every two declarations of one table and report where their
 * columns disagree.
 */
export function checkSchemaAgreement(
  summaries: BehavioralSummary[],
  index?: InteractionIndex,
  /** Where to record what this pass compared; see `ComparedPair`. */
  compared?: ComparedPair[],
): SchemaAgreement {
  const idx = index ?? buildInteractionIndex(summaries);
  const containers = declaredContainers(providersOf(idx, "storage"));
  const result: SchemaAgreement = { findings: [], unchecked: [] };
  const pairs = sameTablePairs(containers.filter(comparable));
  if (pairs.length === 0) {
    return result;
  }

  const aliases = tableAliases(containers);
  for (const [a, b] of pairs) {
    const table = tableOf(sidesOf(declarationOf(a), declarationOf(b)));
    compared?.push({
      key: table.label,
      provider: summaryIdentifier(table.provider.container.summary),
      consumer: summaryIdentifier(table.consumer.container.summary),
    });
    compareTables(table, aliases, result);
  }
  return result;
}

/**
 * Only a declaration that lists every column can say one is missing.
 * SQLite stores by affinity, so a type declared there says little.
 */
function comparable(container: DeclaredContainer): boolean {
  return (
    container.contract.fieldSet === "exhaustive" &&
    container.contract.fields !== undefined &&
    container.semantics.storageSystem !== "sqlite"
  );
}

function sameTablePairs(
  declared: DeclaredContainer[],
): Array<[DeclaredContainer, DeclaredContainer]> {
  const pairs: Array<[DeclaredContainer, DeclaredContainer]> = [];
  for (let i = 0; i < declared.length; i++) {
    const a = declared[i] as DeclaredContainer;
    for (let j = i + 1; j < declared.length; j++) {
      const b = declared[j] as DeclaredContainer;
      if (oneTable(a, b) && !answeredByAThird(a, b, declared)) {
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

function oneTable(a: DeclaredContainer, b: DeclaredContainer): boolean {
  return (
    enginesMeet(a.semantics, b.semantics) &&
    a.semantics.scope === b.semantics.scope &&
    a.semantics.accessPath === b.semantics.accessPath &&
    sameService(a.summary, b.summary) &&
    a.names.some((name) => b.names.some((other) => namesAgree(name, other)))
  );
}

/** A store whose engine nobody settled meets one on any engine. */
function enginesMeet(a: StorageSemantics, b: StorageSemantics): boolean {
  return (
    a.storageSystem === null ||
    b.storageSystem === null ||
    a.storageSystem === b.storageSystem
  );
}

/**
 * Two copies that a dump both pair with are each checked against the
 * dump, and checking them against each other would report it twice.
 */
function answeredByAThird(
  a: DeclaredContainer,
  b: DeclaredContainer,
  declared: DeclaredContainer[],
): boolean {
  if (speaksForDatabase(a) || speaksForDatabase(b)) {
    return false;
  }
  return declared.some(
    (third) =>
      third !== a &&
      third !== b &&
      speaksForDatabase(third) &&
      oneTable(third, a) &&
      oneTable(third, b),
  );
}

const ORIGIN_AUTHORITY: Record<
  NonNullable<StorageContractMetadata["origin"]> | "unstated",
  number
> = {
  dump: 2,
  migrations: 1,
  unstated: 0,
};

/** The project's word outranks anything a reader worked out. */
const STATED_SOURCE_AUTHORITY = 3;

function authority(contract: StorageContractMetadata): number {
  if (contract.source === true) {
    return STATED_SOURCE_AUTHORITY;
  }
  return ORIGIN_AUTHORITY[contract.origin ?? "unstated"];
}

function speaksForDatabase(container: DeclaredContainer): boolean {
  return authority(container.contract) >= ORIGIN_AUTHORITY.dump;
}

/** One declaration's columns, keyed by what the database stores them under. */
interface Declaration {
  container: DeclaredContainer;
  columns: Map<string, ContractField>;
}

function declarationOf(container: DeclaredContainer): Declaration {
  const columns = new Map<string, ContractField>();
  for (const field of container.contract.fields ?? []) {
    // A relation or a computed count is not a column of the table.
    if (field.derived === true) {
      continue;
    }
    columns.set(field.column ?? field.name, field);
  }
  return { container, columns };
}

interface Sides {
  provider: Declaration;
  consumer: Declaration;
  /** Whether the provider is known to match the database and the consumer is not. */
  settled: boolean;
}

function sidesOf(a: Declaration, b: Declaration): Sides {
  const [provider, consumer] = providerFirst(a, b);
  return {
    provider,
    consumer,
    settled:
      speaksForDatabase(provider.container) &&
      authority(provider.container.contract) >
        authority(consumer.container.contract),
  };
}

/** Between two of equal authority, the path that sorts first. */
function providerFirst(
  a: Declaration,
  b: Declaration,
): [Declaration, Declaration] {
  const ahead =
    authority(a.container.contract) - authority(b.container.contract);
  if (ahead !== 0) {
    return ahead > 0 ? [a, b] : [b, a];
  }
  return sortKey(a) <= sortKey(b) ? [a, b] : [b, a];
}

function sortKey(declaration: Declaration): string {
  const summary = declaration.container.summary;
  return `${summary.location.file}\0${summaryIdentifier(summary)}`;
}

interface Table extends Sides {
  /** The table as the database spells it. */
  name: string;
  label: string;
}

function tableOf(sides: Sides): Table {
  const container = sides.provider.container;
  return {
    ...sides,
    name: container.contract.physicalTable ?? (container.names[0] as string),
    label: storageLabel(container.semantics),
  };
}

function fileOf(declaration: Declaration): string {
  return declaration.container.summary.location.file;
}

const EITHER_STALE =
  "Neither one is known to match the database, so either could be out of date.";

function compareTables(
  table: Table,
  aliases: TableAliases,
  into: SchemaAgreement,
): void {
  const providerKey = primaryKeyOf(table.provider);
  const consumerKey = primaryKeyOf(table.consumer);
  const keyless = keylessSide(table, providerKey, consumerKey);
  if (keyless !== null) {
    into.unchecked.push(
      uncheckedEntry(
        table,
        null,
        `${fileOf(keyless)} declares no primary key, so nothing shows the two declarations are one table`,
      ),
    );
    return;
  }

  // Two databases can each have a table of this name, and their columns
  // would disagree everywhere for no reason anyone could fix.
  if (!keysAgree(providerKey, consumerKey)) {
    into.findings.push(keysDifferFinding(table, providerKey, consumerKey));
    return;
  }

  for (const column of columnsOf(table)) {
    compareColumn(table, column, aliases, into);
  }
}

function keylessSide(
  table: Table,
  providerKey: Map<string, ContractField>,
  consumerKey: Map<string, ContractField>,
): Declaration | null {
  if (providerKey.size === 0) {
    return table.provider;
  }
  if (consumerKey.size === 0) {
    return table.consumer;
  }
  return null;
}

function primaryKeyOf(declaration: Declaration): Map<string, ContractField> {
  const key = new Map<string, ContractField>();
  for (const [column, field] of declaration.columns) {
    if (field.primary === true) {
      key.set(column, field);
    }
  }
  return key;
}

/** A type suss has no family for agrees with any. */
function keysAgree(
  provider: Map<string, ContractField>,
  consumer: Map<string, ContractField>,
): boolean {
  if (provider.size !== consumer.size) {
    return false;
  }
  for (const [column, field] of provider) {
    const other = consumer.get(column);
    if (other === undefined) {
      return false;
    }
    const family = familyOfField(field);
    const otherFamily = familyOfField(other);
    if (
      family !== undefined &&
      otherFamily !== undefined &&
      family !== otherFamily
    ) {
      return false;
    }
  }
  return true;
}

function familyOfField(field: ContractField): Family | undefined {
  return field.type === undefined ? undefined : familyOf(field.type);
}

/** The provider's columns in its order, then the ones only the consumer has. */
function columnsOf(table: Table): string[] {
  const columns = [...table.provider.columns.keys()];
  for (const column of table.consumer.columns.keys()) {
    if (!table.provider.columns.has(column)) {
      columns.push(column);
    }
  }
  return columns;
}

/** One column as each side declares it. */
interface ColumnPair {
  column: string;
  /** `table.column`, as a description starts. */
  label: string;
  provider: ContractField | undefined;
  consumer: ContractField | undefined;
}

interface BothSides extends ColumnPair {
  provider: ContractField;
  consumer: ContractField;
}

function compareColumn(
  table: Table,
  column: string,
  aliases: TableAliases,
  into: SchemaAgreement,
): void {
  const pair: ColumnPair = {
    column,
    label: `${table.name}.${column}`,
    provider: table.provider.columns.get(column),
    consumer: table.consumer.columns.get(column),
  };
  if (!declaredOnBoth(pair)) {
    into.findings.push(...presenceFindings(table, pair));
    return;
  }

  compareTypes(table, pair, into);
  into.findings.push(
    ...nullabilityFindings(table, pair),
    ...defaultFindings(table, pair),
    ...foreignKeyFindings(table, pair, aliases),
  );
}

function declaredOnBoth(pair: ColumnPair): pair is BothSides {
  return pair.provider !== undefined && pair.consumer !== undefined;
}

function compareTypes(
  table: Table,
  pair: BothSides,
  into: SchemaAgreement,
): void {
  const unread =
    unreadType(table.provider, pair.provider) ??
    unreadType(table.consumer, pair.consumer);
  if (unread !== null) {
    into.unchecked.push(uncheckedEntry(table, pair.column, unread));
    return;
  }

  const providerType = pair.provider.type as string;
  const consumerType = pair.consumer.type as string;
  if (familyOf(providerType) === familyOf(consumerType)) {
    return;
  }
  const stated = `${pair.label}: ${fileOf(table.provider)} declares ${providerType} and ${fileOf(table.consumer)} declares ${consumerType}.`;
  const outcome = table.settled
    ? `The database contains ${providerType} values the copy cannot read, and refuses the ${consumerType} it writes.`
    : "Whichever one is wrong reads values it cannot parse and writes values the table refuses.";
  into.findings.push(
    columnFinding(
      "boundaryShapeMismatch",
      "error",
      table,
      pair,
      `${stated} ${outcome}`,
    ),
  );
}

function unreadType(
  declaration: Declaration,
  field: ContractField,
): string | null {
  if (field.type === undefined) {
    return `${fileOf(declaration)} states no type`;
  }
  if (familyOf(field.type) === undefined) {
    return `${fileOf(declaration)} declares ${field.type}, which suss has no type family for`;
  }
  return null;
}

function nullabilityFindings(table: Table, pair: BothSides): Finding[] {
  const providerNullable = pair.provider.nullable;
  const consumerNullable = pair.consumer.nullable;
  if (
    providerNullable === undefined ||
    consumerNullable === undefined ||
    providerNullable === consumerNullable
  ) {
    return [];
  }
  const stated = `${pair.label}: ${fileOf(table.provider)} declares it ${nullWord(providerNullable)} and ${fileOf(table.consumer)} declares it ${nullWord(consumerNullable)}.`;
  return [
    columnFinding(
      "boundaryShapeMismatch",
      "error",
      table,
      pair,
      `${stated} ${nullabilityOutcome(table, providerNullable)}`,
    ),
  ];
}

function nullWord(nullable: boolean): string {
  return nullable ? "nullable" : "NOT NULL";
}

function nullabilityOutcome(table: Table, providerNullable: boolean): string {
  if (!table.settled) {
    const [nullable, notNull] = providerNullable
      ? [table.provider, table.consumer]
      : [table.consumer, table.provider];
    return `If the column is NOT NULL, ${fileOf(nullable)} writes NULLs the table refuses. If it is nullable, ${fileOf(notNull)} reads NULLs it does not expect.`;
  }
  return providerNullable
    ? "The database can return NULL there, and the copy does not expect it."
    : "The copy can write NULL there, and the database refuses it.";
}

function defaultFindings(table: Table, pair: BothSides): Finding[] {
  const providerDefault = pair.provider.default;
  const consumerDefault = pair.consumer.default;
  if (
    providerDefault === undefined ||
    consumerDefault === undefined ||
    providerDefault === consumerDefault
  ) {
    return [];
  }
  if (!table.settled) {
    const [has, lacks] = providerDefault
      ? [table.provider, table.consumer]
      : [table.consumer, table.provider];
    return [
      columnFinding(
        "boundaryShapeMismatch",
        "warning",
        table,
        pair,
        `${pair.label}: ${fileOf(has)} declares a database default and ${fileOf(lacks)} declares none. ${EITHER_STALE}`,
      ),
    ];
  }
  // The copy supplies a value every time, so a default it lacks is never used.
  if (providerDefault) {
    return [];
  }
  return copyDefaultFindings(table, pair);
}

/** A default the copy declares and the database lacks. */
function copyDefaultFindings(table: Table, pair: BothSides): Finding[] {
  const nullable = pair.provider.nullable;
  if (nullable === undefined) {
    return [];
  }
  const stated = `${pair.label}: ${fileOf(table.consumer)} declares a database default and ${fileOf(table.provider)} declares none on a ${nullWord(nullable)} column.`;
  return [
    nullable
      ? columnFinding(
          "boundaryShapeMismatch",
          "warning",
          table,
          pair,
          `${stated} An insert through the copy that leaves it out stores NULL, and nothing says so.`,
        )
      : columnFinding(
          "boundaryShapeMismatch",
          "error",
          table,
          pair,
          `${stated} An insert through the copy that leaves it out is refused.`,
        ),
  ];
}

function foreignKeyFindings(
  table: Table,
  pair: BothSides,
  aliases: TableAliases,
): Finding[] {
  const providerTarget = pair.provider.foreignKey;
  const consumerTarget = pair.consumer.foreignKey;
  if (
    providerTarget === undefined ||
    consumerTarget === undefined ||
    sameTable(providerTarget, consumerTarget, aliases)
  ) {
    return [];
  }
  const outcome = table.settled
    ? "A join written against the copy reaches a different table from the one the database links it to."
    : EITHER_STALE;
  return [
    columnFinding(
      "boundaryShapeMismatch",
      "warning",
      table,
      pair,
      `${pair.label}: ${fileOf(table.provider)} points it at ${providerTarget} and ${fileOf(table.consumer)} points it at ${consumerTarget}. ${outcome}`,
    ),
  ];
}

/**
 * Every name each declared table goes by, so a foreign key to the Prisma
 * model `User` mapped to `users` meets one that says `users`.
 */
type TableAliases = Map<string, Set<string>>;

function tableAliases(containers: DeclaredContainer[]): TableAliases {
  const aliases: TableAliases = new Map();
  for (const container of containers) {
    for (const name of container.names) {
      const known = aliases.get(name) ?? new Set([name]);
      for (const other of container.names) {
        known.add(other);
      }
      aliases.set(name, known);
    }
  }
  return aliases;
}

function sameTable(a: string, b: string, aliases: TableAliases): boolean {
  const right = aliases.get(b) ?? new Set([b]);
  return [...(aliases.get(a) ?? [a])].some((name) => right.has(name));
}

function presenceFindings(table: Table, pair: ColumnPair): Finding[] {
  const { provider, consumer } = pair;
  if (!table.settled) {
    const [has, lacks] =
      provider !== undefined
        ? [table.provider, table.consumer]
        : [table.consumer, table.provider];
    return [
      columnFinding(
        "boundaryFieldUnknown",
        "warning",
        table,
        pair,
        `${pair.label}: ${fileOf(has)} declares the column and ${fileOf(lacks)} does not. ${EITHER_STALE}`,
      ),
    ];
  }
  if (consumer !== undefined) {
    return [
      columnFinding(
        "boundaryFieldUnknown",
        "error",
        table,
        pair,
        `${pair.label}: ${fileOf(table.consumer)} declares the column and ${fileOf(table.provider)} has no such column. Every query through the copy that selects it fails.`,
      ),
    ];
  }
  // A partial copy is how Drizzle and Prisma are meant to be used, so
  // only a column every insert has to supply is reported.
  if (provider?.nullable !== false || provider.default !== false) {
    return [];
  }
  return [
    columnFinding(
      "boundaryFieldUnknown",
      "error",
      table,
      pair,
      `${pair.label}: ${fileOf(table.provider)} declares it NOT NULL with no default, and ${fileOf(table.consumer)} leaves it out. The copy cannot supply it, so the database refuses every insert through the copy.`,
    ),
  ];
}

function keysDifferFinding(
  table: Table,
  providerKey: Map<string, ContractField>,
  consumerKey: Map<string, ContractField>,
): Finding {
  return {
    kind: "boundaryShapeMismatch",
    boundary: table.provider.container.binding,
    provider: makeSide(table.provider.container.summary),
    consumer: makeSide(table.consumer.container.summary),
    description: `${table.name}: ${fileOf(table.provider)} keys it on ${keyText(providerKey)} and ${fileOf(table.consumer)} keys it on ${keyText(consumerKey)}. These may be two databases that each have a table of this name, so no column was compared. If they are, give each its own scope.`,
    severity: "warning",
  };
}

function keyText(key: Map<string, ContractField>): string {
  return [...key]
    .map(([column, field]) =>
      field.type === undefined ? column : `${column} (${field.type})`,
    )
    .join(", ");
}

function columnFinding(
  kind: Finding["kind"],
  severity: FindingSeverity,
  table: Table,
  pair: ColumnPair,
  description: string,
): Finding {
  return {
    kind,
    boundary: table.provider.container.binding,
    provider: sideOf(table.provider, pair.provider),
    consumer: sideOf(table.consumer, pair.consumer),
    description,
    severity,
  };
}

/** The field is what this side's code calls the column, which a rule keys on. */
function sideOf(
  declaration: Declaration,
  field: ContractField | undefined,
): FindingSide {
  const side = makeSide(declaration.container.summary);
  if (field !== undefined) {
    side.field = field.name;
  }
  return side;
}

function uncheckedEntry(
  table: Table,
  column: string | null,
  reason: string,
): UncheckedColumn {
  return {
    boundary: table.label,
    provider: summaryIdentifier(table.provider.container.summary),
    consumer: summaryIdentifier(table.consumer.container.summary),
    column,
    reason,
  };
}
