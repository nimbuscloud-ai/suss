/**
 * Reads a Prisma schema into one storage summary per model and view, plus
 * one per implicit many-to-many join table. The checker's storage pass
 * pairs these with the `storage-access` interactions found in code.
 *
 * `@mrleebo/prisma-ast` parses the schema, so no Prisma runtime or
 * generated client is needed. A schema whose datasource is not relational,
 * such as MongoDB, comes back empty. The README lists what else is left out.
 */

import fs from "node:fs";
import path from "node:path";

import { getSchema } from "@mrleebo/prisma-ast";

import { storageBinding } from "@suss/behavioral-ir";
import { defaultProjectRoot, pathInProject } from "@suss/behavioral-ir/files";

import type {
  BehavioralSummary,
  StorageContractMetadata,
} from "@suss/behavioral-ir";

export interface PrismaSchemaToSummariesOptions {
  /** The path recorded on each summary, in place of the default. */
  source?: string;
  /**
   * Defaults to `"default"`. With several Prisma schemas in one repo, give
   * each its own scope so their pairings stay separate.
   */
  scope?: string;
  /** `"migrations"` when Prisma's own migrations made the database. */
  origin?: "migrations";
}

export interface PrismaSchemaFileToSummariesOptions
  extends PrismaSchemaToSummariesOptions {
  /** Absolute. The directory each schema file's path is measured from. */
  projectRoot?: string;
}

type ContractField = NonNullable<StorageContractMetadata["fields"]>[number];

/**
 * A field of one of these types is a column. Any other field type is an
 * enum, which is also a column, or another model, which is a relation.
 */
const PRISMA_SCALARS = new Set([
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "String",
  "Boolean",
  "DateTime",
  "Json",
  "Bytes",
]);

/**
 * Prisma accepts both `postgresql` and `postgres` as a provider, and the
 * storage binding uses one spelling for both.
 */
const PROVIDER_TO_SYSTEM: Record<string, "postgresql" | "mysql" | "sqlite"> = {
  postgresql: "postgresql",
  postgres: "postgresql",
  mysql: "mysql",
  sqlite: "sqlite",
};

interface PrismaField {
  type: "field";
  name: string;
  /** An object for `Unsupported("...")`, so it is never a model or enum name. */
  fieldType: string;
  array?: boolean;
  optional?: boolean;
  attributes?: PrismaAttribute[];
}

interface PrismaAttribute {
  type: "attribute";
  name: string;
  kind?: "field" | "object";
  group?: string;
  args?: Array<{
    type: "attributeArgument";
    value: unknown;
  }>;
}

interface PrismaModel {
  type: "model" | "view";
  name: string;
  properties: Array<PrismaField | PrismaAttribute | { type: string }>;
}

interface PrismaDatasource {
  type: "datasource";
  assignments: Array<{
    type: "assignment";
    key: string;
    value: unknown;
  }>;
}

/**
 * Converts Prisma schema text into summaries. Returns an empty array when
 * the datasource is not relational.
 */
export function prismaSchemaToSummaries(
  source: string,
  options: PrismaSchemaToSummariesOptions = {},
): BehavioralSummary[] {
  return summariesOfSchema(
    [{ file: options.source ?? "schema.prisma", text: source }],
    options.scope ?? "default",
    options.origin,
  );
}

/** The text of one file of a schema, and the path its summaries record. */
interface SchemaSource {
  file: string;
  text: string;
}

/**
 * Prisma reads the files of a multi-file schema as one, so a field in one
 * file can refer to a model in another, and only one file has the datasource.
 */
function summariesOfSchema(
  sources: readonly SchemaSource[],
  scope: string,
  origin: "migrations" | undefined,
): BehavioralSummary[] {
  const nodes = sources.flatMap(({ file, text }) =>
    (getSchema(text) as { list: Array<unknown> }).list.map((node) => ({
      node,
      file,
    })),
  );
  const list = nodes.map(({ node }) => node);

  // Names are collected first, because a field can refer to a model or
  // enum declared later in the file, or in another file of the schema.
  const modelNames = new Set<string>();
  const enumNames = new Set<string>();
  const storageSystem = storageSystemIn(list);

  for (const node of list) {
    const n = node as { type: string; name?: string };
    if (n.type === "model" || n.type === "view") {
      if (typeof n.name === "string") {
        modelNames.add(n.name);
      }
    } else if (n.type === "enum") {
      if (typeof n.name === "string") {
        enumNames.add(n.name);
      }
    }
  }

  if (storageSystem === null) {
    // A schema for MongoDB or another document store, which needs a
    // different kind of boundary.
    return [];
  }

  const summaries: BehavioralSummary[] = [];
  const models = list.filter(
    (node): node is PrismaModel => (node as { type: string }).type === "model",
  );
  const fileOfModel = new Map(
    nodes.map(({ node, file }) => [(node as { name?: string }).name, file]),
  );
  const relations = implicitManyToManyRelations(models, modelNames);
  const tableOfModel = new Map(
    models.map((model) => [model.name, physicalTableOf(model) ?? model.name]),
  );
  const joinContainerByField = new Map<string, string>();
  for (const relation of relations) {
    joinContainerByField.set(
      `${relation.leftModel}.${relation.leftField}`,
      relation.joinTable,
    );
    joinContainerByField.set(
      `${relation.rightModel}.${relation.rightField}`,
      relation.joinTable,
    );
  }

  for (const { node, file } of nodes) {
    const n = node as { type: string };
    if (n.type !== "model" && n.type !== "view") {
      continue;
    }
    const model = node as PrismaModel;
    summaries.push(
      buildModelSummary({
        model,
        modelNames,
        enumNames,
        tableOfModel,
        storageSystem,
        scope,
        origin,
        sourceFile: file,
        joinContainerByField,
      }),
    );
  }

  for (const relation of relations) {
    summaries.push(
      buildJoinTableSummary({
        relation,
        tableOfModel,
        storageSystem,
        scope,
        origin,
        sourceFile: fileOfModel.get(relation.leftModel) ?? "schema.prisma",
      }),
    );
  }

  return summaries;
}

/**
 * A table Prisma manages for two list fields that point at each other when
 * neither declares a foreign key. An explicit join model has
 * `@relation(fields: [...])` on one of its fields, so it never matches.
 */
interface ImplicitManyToMany {
  leftModel: string;
  leftField: string;
  rightModel: string;
  rightField: string;
  relationName: string | null;
  joinTable: string;
}

/** Each relation appears once, whichever side it is found from. */
function implicitManyToManyRelations(
  models: PrismaModel[],
  modelNames: Set<string>,
): ImplicitManyToMany[] {
  const byName = new Map(models.map((model) => [model.name, model]));
  const found: ImplicitManyToMany[] = [];
  const seen = new Set<string>();

  for (const model of models) {
    for (const property of model.properties) {
      if ((property as { type: string }).type !== "field") {
        continue;
      }
      const field = property as PrismaField;
      if (
        field.array !== true ||
        !modelNames.has(field.fieldType) ||
        relationKeyOf(field) !== null
      ) {
        continue;
      }
      const target = byName.get(field.fieldType);
      if (target === undefined) {
        continue;
      }
      const relationName = relationNameOf(field);
      const counterpart = counterpartField(
        target,
        model.name,
        field.name,
        relationName,
      );
      if (counterpart === null) {
        continue;
      }
      const signature = pairSignature(
        { model: model.name, field: field.name },
        { model: field.fieldType, field: counterpart.name },
      );
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      found.push({
        leftModel: model.name,
        leftField: field.name,
        rightModel: field.fieldType,
        rightField: counterpart.name,
        relationName,
        joinTable: joinTableName(model.name, field.fieldType, relationName),
      });
    }
  }
  return found;
}

/**
 * The list field on the other model that points back with the same
 * relation name, where two unnamed relations match. On a self-relation the
 * field itself is skipped.
 */
function counterpartField(
  target: PrismaModel,
  backTo: string,
  ownFieldName: string,
  relationName: string | null,
): PrismaField | null {
  for (const property of target.properties) {
    if ((property as { type: string }).type !== "field") {
      continue;
    }
    const field = property as PrismaField;
    if (target.name === backTo && field.name === ownFieldName) {
      continue;
    }
    if (
      field.array === true &&
      field.fieldType === backTo &&
      relationKeyOf(field) === null &&
      relationNameOf(field) === relationName
    ) {
      return field;
    }
  }
  return null;
}

function pairSignature(
  a: { model: string; field: string },
  b: { model: string; field: string },
): string {
  const label = (side: { model: string; field: string }) =>
    `${side.model}.${side.field}`;
  return [label(a), label(b)].sort().join("|");
}

/**
 * Prisma calls the table `_<RelationName>`, or `_<A>To<B>` with the two
 * model names sorted when the relation is unnamed.
 */
function joinTableName(
  leftModel: string,
  rightModel: string,
  relationName: string | null,
): string {
  if (relationName !== null) {
    return `_${relationName}`;
  }
  const [first, second] = [leftModel, rightModel].sort();
  return `_${first}To${second}`;
}

interface BuildJoinTableOpts {
  relation: ImplicitManyToMany;
  tableOfModel: Map<string, string>;
  storageSystem: "postgresql" | "mysql" | "sqlite";
  scope: string;
  origin: "migrations" | undefined;
  sourceFile: string;
}

/**
 * Prisma gives the table two columns, `A` and `B`, for the models whose
 * names sort first and second. The client's `connect`, `disconnect` and
 * `set` write rows here, though the code never mentions the table.
 */
function buildJoinTableSummary(opts: BuildJoinTableOpts): BehavioralSummary {
  const [modelA, modelB] = [
    opts.relation.leftModel,
    opts.relation.rightModel,
  ].sort() as [string, string];
  const keyColumn = (name: string, model: string): ContractField => ({
    name,
    type: model,
    nullable: false,
    primary: true,
    default: false,
    foreignKey: opts.tableOfModel.get(model) ?? model,
  });
  return {
    kind: "library",
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: opts.relation.joinTable,
      exportPath: null,
      boundaryBinding: storageBinding({
        recognition: "prisma",
        storageSystem: opts.storageSystem,
        scope: opts.scope,
        container: opts.relation.joinTable,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: {
        fieldSet: "exhaustive",
        fields: [keyColumn("A", modelA), keyColumn("B", modelB)],
        indexes: [
          { fields: ["A", "B"], unique: true },
          { fields: ["B"], unique: false },
        ],
        ...originOf(opts.origin),
      },
    },
  };
}

/**
 * Reads a Prisma schema from disk and converts it: a file, a schema
 * folder, or one file of a multi-file schema, which brings the rest of
 * its files with it. Throws when the path does not exist. Unless the
 * options say otherwise, the origin is `"migrations"` when a Prisma
 * migrations folder is next to the schema.
 */
export function prismaSchemaFileToSummaries(
  schemaPath: string,
  options: PrismaSchemaFileToSummariesOptions = {},
): BehavioralSummary[] {
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Prisma schema not found: ${schemaPath}`);
  }
  const root = options.projectRoot ?? defaultProjectRoot(schemaPath);
  const files = prismaSchemaFiles(schemaPath);
  const sources = files.map((file) => ({
    file: options.source ?? pathInProject(file, root),
    text: fs.readFileSync(file, "utf-8"),
  }));
  return summariesOfSchema(
    sources,
    options.scope ?? "default",
    options.origin ?? migrationsOriginOf(schemaPath, files),
  );
}

/**
 * Prisma Migrate writes `migration_lock.toml` into its migrations folder.
 * The folder is next to a schema file, and a schema split into a folder
 * of its own can keep it one level up, beside that folder.
 */
function migrationsOriginOf(
  schemaPath: string,
  files: readonly string[],
): "migrations" | undefined {
  const folder = statOf(schemaPath)?.isDirectory() === true;
  const own = folder
    ? path.resolve(schemaPath)
    : path.dirname(path.resolve(schemaPath));
  const searched =
    folder || files.length > 1 ? [own, path.dirname(own)] : [own];
  return searched.some(hasMigrationsFolder) ? "migrations" : undefined;
}

function hasMigrationsFolder(dir: string): boolean {
  return foldersIn(dir).some((folder) =>
    fs.existsSync(path.join(dir, folder, "migration_lock.toml")),
  );
}

function foldersIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function originOf(
  origin: "migrations" | undefined,
): Pick<StorageContractMetadata, "origin"> {
  return origin === undefined ? {} : { origin };
}

/**
 * The files Prisma reads as one schema, given a schema file or folder.
 * Prisma reads every `.prisma` file below a folder. A file with no
 * datasource cannot be a schema on its own, so when only one file in a
 * folder has the datasource, the folder's files are one schema.
 */
export function prismaSchemaFiles(schemaPath: string): string[] {
  const stat = statOf(schemaPath);
  if (stat?.isDirectory() === true) {
    return prismaFilesIn(schemaPath, true);
  }

  if (stat?.isFile() !== true) {
    return [];
  }

  // A file beside it that does not parse is left out of the schema.
  const beside = prismaFilesIn(path.dirname(schemaPath), false).flatMap(
    (file) => {
      const list = schemaListOf(file);
      return list === null ? [] : [{ file, list }];
    },
  );
  const datasources = beside.filter(({ list }) =>
    list.some(isDatasource),
  ).length;
  const given = path.resolve(schemaPath);
  return datasources === 1 &&
    beside.some(({ file }) => path.resolve(file) === given)
    ? beside.map(({ file }) => file)
    : [schemaPath];
}

function statOf(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/** The `.prisma` files in a folder, sorted, and below it when `below` is set. */
function prismaFilesIn(dir: string, below: boolean): string[] {
  return fs
    .readdirSync(dir, { recursive: below, encoding: "utf8" })
    .filter((name) => name.endsWith(".prisma"))
    .map((name) => path.join(dir, name))
    .filter((file) => statOf(file)?.isFile() === true)
    .sort();
}

function schemaListOf(file: string): unknown[] | null {
  try {
    return (getSchema(fs.readFileSync(file, "utf8")) as { list: unknown[] })
      .list;
  } catch {
    return null;
  }
}

function isDatasource(node: unknown): boolean {
  return (node as { type: string }).type === "datasource";
}

// ---------------------------------------------------------------------------
// Per-model summary construction
// ---------------------------------------------------------------------------

interface BuildModelOpts {
  model: PrismaModel;
  modelNames: Set<string>;
  enumNames: Set<string>;
  /** The table each model is stored in, from `@@map` or the model name. */
  tableOfModel: Map<string, string>;
  storageSystem: "postgresql" | "mysql" | "sqlite";
  scope: string;
  origin: "migrations" | undefined;
  sourceFile: string;
  /**
   * The implicit join table each many-to-many field writes through, keyed
   * `<model>.<field>`.
   */
  joinContainerByField: Map<string, string>;
}

function buildModelSummary(opts: BuildModelOpts): BehavioralSummary {
  const columns: ContractField[] = [];
  const indexes: Array<{ fields: string[]; unique: boolean }> = [];
  const physicalTable = physicalTableOf(opts.model);
  const context: ColumnContext = {
    enumNames: opts.enumNames,
    foreignKeys: foreignKeysOf(opts.model, opts.modelNames, opts.tableOfModel),
    compositeKey: compositeKeyOf(opts.model),
    migrated: opts.origin === "migrations",
  };

  let hasRelation = false;
  for (const property of opts.model.properties) {
    if ((property as { type: string }).type === "field") {
      const field = property as PrismaField;
      const column = fieldToColumn(field, opts.modelNames, context);
      if (column !== null) {
        columns.push(column);
      }
      const joinContainer =
        opts.joinContainerByField.get(`${opts.model.name}.${field.name}`) ??
        null;
      const related = relationField(field, opts.modelNames, joinContainer);
      if (related !== null) {
        hasRelation = true;
        columns.push(related);
      }
    } else if ((property as { type: string }).type === "attribute") {
      const attr = property as PrismaAttribute;
      const index = blockAttributeToIndex(attr);
      if (index !== null) {
        indexes.push(index);
      }
    }
  }

  if (hasRelation) {
    columns.push({
      name: "_count",
      type: "PrismaCount",
      nullable: false,
      derived: true,
    });
  }

  return {
    kind: "library",
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: opts.model.name,
      exportPath: null,
      boundaryBinding: storageBinding({
        recognition: "prisma",
        storageSystem: opts.storageSystem,
        scope: opts.scope,
        container: opts.model.name,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: {
        // A Prisma model declares every column its table has, so a
        // column the code touches and this list leaves out is unknown.
        fieldSet: "exhaustive",
        fields: columns,
        indexes,
        ...(physicalTable !== null && physicalTable !== opts.model.name
          ? { physicalTable }
          : {}),
        ...originOf(opts.origin),
      },
    },
  };
}

/**
 * The client accepts a relation field in an `include` or `select`, though
 * no column has its name. Leaving it out of an exhaustive contract would
 * report working code as reading an undeclared field.
 */
function relationField(
  field: PrismaField,
  modelNames: Set<string>,
  joinContainer: string | null,
): {
  name: string;
  type: string;
  nullable: boolean;
  derived: true;
  relationKey?: string[];
  joinContainer?: string;
} | null {
  if (!modelNames.has(field.fieldType)) {
    return null;
  }
  const key = relationKeyOf(field);
  return {
    name: field.name,
    type: field.array === true ? `${field.fieldType}[]` : field.fieldType,
    nullable: field.optional === true,
    derived: true,
    ...(key === null ? {} : { relationKey: key }),
    ...(joinContainer === null ? {} : { joinContainer }),
  };
}

function relationAttributeOf(field: PrismaField): PrismaAttribute | undefined {
  return (field.attributes ?? []).find((attr) => attr.name === "relation");
}

/**
 * Prisma allows `@relation(fields: [...])` on one side of a relation only.
 * The other side and an implicit many-to-many give null, since a connect
 * there writes to a join table and leaves this model's columns alone.
 */
function relationKeyOf(field: PrismaField): string[] | null {
  const relation = relationAttributeOf(field);
  return relation === undefined ? null : readKeyedArrayArg(relation, "fields");
}

/**
 * The name tells apart two many-to-many relations between the same two
 * models, and Prisma names their join table after it.
 */
function relationNameOf(field: PrismaField): string | null {
  const relation = relationAttributeOf(field);
  return relation === undefined ? null : readStringArg(relation);
}

/** What a column reads from the rest of its model. */
interface ColumnContext {
  enumNames: Set<string>;
  /** The table each scalar field's foreign key points at. */
  foreignKeys: Map<string, string>;
  /** The fields `@@id` lists. */
  compositeKey: Set<string>;
  /** Whether Prisma's migrations made the table. */
  migrated: boolean;
}

/**
 * Scalar and enum fields are columns, lists of them included. A relation
 * field is not.
 */
function fieldToColumn(
  field: PrismaField,
  modelNames: Set<string>,
  context: ColumnContext,
): ContractField | null {
  const ft = field.fieldType;
  if (modelNames.has(ft)) {
    return null;
  }
  if (!PRISMA_SCALARS.has(ft) && !context.enumNames.has(ft)) {
    // `Unsupported(...)`, a composite type, or a typo. The field is
    // skipped so the reader never guesses.
    return null;
  }

  const column = stringArgOf(fieldAttribute(field, "map"));
  const nullable = nullableOf(field, context.migrated);
  const databaseDefault = databaseDefaultOf(field, context.migrated);
  const foreignKey = context.foreignKeys.get(field.name);
  const primary =
    fieldAttribute(field, "id") !== undefined ||
    context.compositeKey.has(field.name);
  return {
    name: field.name,
    ...(column !== null && column !== field.name ? { column } : {}),
    type: columnTypeOf(field, context.enumNames),
    ...(nullable === undefined ? {} : { nullable }),
    ...(primary ? { primary: true } : {}),
    ...(fieldAttribute(field, "unique") !== undefined ? { unique: true } : {}),
    ...(databaseDefault === undefined ? {} : { default: databaseDefault }),
    ...(foreignKey === undefined ? {} : { foreignKey }),
  };
}

/** A field attribute such as `@map`. A native type such as `@db.Uuid` never matches. */
function fieldAttribute(
  field: PrismaField,
  name: string,
): PrismaAttribute | undefined {
  return (field.attributes ?? []).find(
    (attr) => attr.name === name && attr.group === undefined,
  );
}

function columnTypeOf(field: PrismaField, enumNames: Set<string>): string {
  const element = elementTypeOf(field, enumNames);
  return field.array === true ? `${element}[]` : element;
}

/**
 * The native type, such as `@db.VarChar` without its length, says more
 * than the Prisma type. Every enum is one type.
 */
function elementTypeOf(field: PrismaField, enumNames: Set<string>): string {
  const native = (field.attributes ?? []).find((attr) => attr.group === "db");
  if (native !== undefined) {
    return `@db.${native.name}`;
  }
  return enumNames.has(field.fieldType) ? "enum" : field.fieldType;
}

/**
 * Prisma's migrations make a list column nullable, and the client reads
 * NULL there as an empty list, so a list's nullability is known only
 * when Prisma made the table.
 */
function nullableOf(
  field: PrismaField,
  migrated: boolean,
): boolean | undefined {
  if (field.array === true) {
    return migrated ? true : undefined;
  }
  return field.optional === true;
}

/**
 * Who fills a column that a create leaves out, by its `@default(...)`.
 * `"both"` is a literal or `now()`: Prisma's migrations make it a
 * database default, and the client also sends the value on every create.
 */
type DefaultFiller = "nobody" | "database" | "client" | "both" | "unknown";

const DEFAULT_FUNCTION_FILLERS: Readonly<
  Record<string, DefaultFiller | undefined>
> = {
  autoincrement: "database",
  dbgenerated: "database",
  now: "both",
  uuid: "client",
  cuid: "client",
  nanoid: "client",
  ulid: "client",
};

/**
 * Whether the database fills the column. A value the client sends on
 * every create says nothing about the database unless Prisma's
 * migrations made the table, so it is left unstated otherwise.
 */
const DATABASE_DEFAULT: Record<
  DefaultFiller,
  (migrated: boolean) => boolean | undefined
> = {
  nobody: () => false,
  database: () => true,
  client: () => false,
  both: (migrated) => (migrated ? true : undefined),
  unknown: () => undefined,
};

function databaseDefaultOf(
  field: PrismaField,
  migrated: boolean,
): boolean | undefined {
  return DATABASE_DEFAULT[defaultFillerOf(field)](migrated);
}

function defaultFillerOf(field: PrismaField): DefaultFiller {
  const value = (fieldAttribute(field, "default")?.args ?? []).find(
    (arg) => (arg.value as { type?: string } | null)?.type !== "keyValue",
  )?.value;
  if (value === undefined) {
    return "nobody";
  }
  const call = value as { type?: string; name?: string } | null;
  if (call?.type !== "function") {
    return "both";
  }
  return DEFAULT_FUNCTION_FILLERS[call.name ?? ""] ?? "unknown";
}

/**
 * Each column a relation's `fields: [...]` lists points at the table of
 * the model the relation field has as its type.
 */
function foreignKeysOf(
  model: PrismaModel,
  modelNames: Set<string>,
  tableOfModel: Map<string, string>,
): Map<string, string> {
  const targets = new Map<string, string>();
  for (const property of model.properties) {
    if ((property as { type: string }).type !== "field") {
      continue;
    }
    const field = property as PrismaField;
    if (!modelNames.has(field.fieldType)) {
      continue;
    }
    const table = tableOfModel.get(field.fieldType) ?? field.fieldType;
    for (const column of relationKeyOf(field) ?? []) {
      targets.set(column, table);
    }
  }
  return targets;
}

function compositeKeyOf(model: PrismaModel): Set<string> {
  for (const property of model.properties) {
    const attr = property as PrismaAttribute;
    if (attr.type === "attribute" && attr.name === "id") {
      return new Set(blockFieldsOf(attr) ?? []);
    }
  }
  return new Set();
}

/**
 * The SQL table name from `@@map("...")`, or null when the table has the
 * model's name. Code that uses SQL names directly, such as Drizzle's
 * `pgTable("users")`, pairs with a mapped model through this.
 */
function physicalTableOf(model: PrismaModel): string | null {
  for (const property of model.properties) {
    if ((property as { type: string }).type !== "attribute") {
      continue;
    }
    const attr = property as PrismaAttribute;
    if (attr.name !== "map") {
      continue;
    }
    const name = stringArgOf(attr);
    if (name !== null) {
      return name;
    }
  }
  return null;
}

/** The string `@map("...")` or `@map(name: "...")` gives. */
function stringArgOf(attr: PrismaAttribute | undefined): string | null {
  if (attr === undefined) {
    return null;
  }
  const positional = readStringArg(attr);
  if (positional !== null) {
    return positional;
  }
  for (const arg of attr.args ?? []) {
    const value = arg.value as { type?: string; key?: string; value?: unknown };
    if (
      value?.type === "keyValue" &&
      value.key === "name" &&
      typeof value.value === "string"
    ) {
      return value.value.replace(/^"|"$/g, "");
    }
  }
  return null;
}

function readStringArg(attr: PrismaAttribute): string | null {
  for (const arg of attr.args ?? []) {
    const value = arg.value;
    if (typeof value === "string") {
      // prisma-ast keeps the quotes on string literals.
      return value.replace(/^"|"$/g, "");
    }
  }
  return null;
}

/**
 * `@@index`, `@@unique` and `@@id` become index entries, and any other
 * block attribute gives null. `@@map` is read separately.
 */
function blockAttributeToIndex(
  attr: PrismaAttribute,
): { fields: string[]; unique: boolean } | null {
  if (attr.name !== "index" && attr.name !== "unique" && attr.name !== "id") {
    return null;
  }
  const fields = blockFieldsOf(attr);
  if (fields === null) {
    return null;
  }
  return { fields, unique: attr.name !== "index" };
}

/** The fields `@@id([a, b])` lists, also spelled `@@id(fields: [a, b])`. */
function blockFieldsOf(attr: PrismaAttribute): string[] | null {
  return readArrayArg(attr) ?? readKeyedArrayArg(attr, "fields");
}

function readArrayArg(attr: PrismaAttribute): string[] | null {
  for (const arg of attr.args ?? []) {
    const names = arrayNames(arg.value);
    if (names !== null) {
      return names;
    }
  }
  return null;
}

/**
 * A field attribute's arguments can come in any order, so only the
 * argument's name tells `fields` from `references`.
 */
function readKeyedArrayArg(
  attr: PrismaAttribute,
  key: string,
): string[] | null {
  for (const arg of attr.args ?? []) {
    const value = arg.value as {
      type?: string;
      key?: string;
      value?: unknown;
    } | null;
    if (value?.type !== "keyValue" || value.key !== key) {
      continue;
    }
    return arrayNames(value.value);
  }
  return null;
}

/** The strings an array value contains, or null when it is not an array. */
function arrayNames(value: unknown): string[] | null {
  const array = value as { type?: string; args?: unknown[] } | null;
  if (array?.type !== "array" || !Array.isArray(array.args)) {
    return null;
  }
  const out: string[] = [];
  for (const item of array.args) {
    if (typeof item === "string") {
      out.push(item);
    } else if (
      typeof item === "object" &&
      item !== null &&
      "name" in item &&
      typeof (item as { name?: unknown }).name === "string"
    ) {
      out.push((item as { name: string }).name);
    }
  }
  return out;
}

export type PrismaStorageSystem = "postgresql" | "mysql" | "sqlite";

/**
 * The storage system the datasource provider says, or null for MongoDB or
 * a file with no datasource. The client pack binds its calls with this.
 */
export function prismaStorageSystem(
  source: string,
): PrismaStorageSystem | null {
  try {
    return storageSystemIn((getSchema(source) as { list: unknown[] }).list);
  } catch {
    return null;
  }
}

function storageSystemIn(list: readonly unknown[]): PrismaStorageSystem | null {
  for (const node of list) {
    if ((node as { type: string }).type !== "datasource") {
      continue;
    }
    const provider = readProviderString(node as PrismaDatasource);
    if (provider !== null && provider in PROVIDER_TO_SYSTEM) {
      return PROVIDER_TO_SYSTEM[provider];
    }
  }
  return null;
}

function readProviderString(ds: PrismaDatasource): string | null {
  for (const a of ds.assignments) {
    if (a.key !== "provider") {
      continue;
    }
    if (typeof a.value === "string") {
      // prisma-ast keeps the quotes on string literals.
      return a.value.replace(/^"|"$/g, "");
    }
  }
  return null;
}
