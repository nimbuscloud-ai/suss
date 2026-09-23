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

import type { BehavioralSummary } from "@suss/behavioral-ir";

export interface PrismaSchemaToSummariesOptions {
  /** The path recorded on each summary, in place of the default. */
  source?: string;
  /**
   * Defaults to `"default"`. With several Prisma schemas in one repo, give
   * each its own scope so their pairings stay separate.
   */
  scope?: string;
}

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
  const ast = getSchema(source);
  const list = (ast as { list: Array<unknown> }).list;

  // Names are collected first, because a field can refer to a model or
  // enum declared later in the file.
  const modelNames = new Set<string>();
  const enumNames = new Set<string>();
  let storageSystem: "postgresql" | "mysql" | "sqlite" | null = null;

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
    } else if (n.type === "datasource") {
      const ds = node as PrismaDatasource;
      const provider = readProviderString(ds);
      if (provider !== null && provider in PROVIDER_TO_SYSTEM) {
        storageSystem = PROVIDER_TO_SYSTEM[provider];
      }
    }
  }

  if (storageSystem === null) {
    // A schema for MongoDB or another document store, which needs a
    // different kind of boundary.
    return [];
  }

  const sourceFile = options.source ?? "schema.prisma";
  const scope = options.scope ?? "default";
  const summaries: BehavioralSummary[] = [];
  const models = list.filter(
    (node): node is PrismaModel => (node as { type: string }).type === "model",
  );
  const relations = implicitManyToManyRelations(models, modelNames);
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

  for (const node of list) {
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
        storageSystem,
        scope,
        sourceFile,
        joinContainerByField,
      }),
    );
  }

  for (const relation of relations) {
    summaries.push(
      buildJoinTableSummary({ relation, storageSystem, scope, sourceFile }),
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
  storageSystem: "postgresql" | "mysql" | "sqlite";
  scope: string;
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
  ].sort();
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
        fields: [
          { name: "A", type: modelA, nullable: false, primary: true },
          { name: "B", type: modelB, nullable: false, primary: true },
        ],
        indexes: [
          { fields: ["A", "B"], unique: true },
          { fields: ["B"], unique: false },
        ],
      },
    },
  };
}

/**
 * Reads a Prisma schema file and converts it. Throws when the file does
 * not exist.
 */
export function prismaSchemaFileToSummaries(
  schemaPath: string,
  options: PrismaSchemaToSummariesOptions = {},
): BehavioralSummary[] {
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Prisma schema not found: ${schemaPath}`);
  }
  const source = fs.readFileSync(schemaPath, "utf-8");
  return prismaSchemaToSummaries(source, {
    ...options,
    source: options.source ?? path.relative(process.cwd(), schemaPath),
  });
}

// ---------------------------------------------------------------------------
// Per-model summary construction
// ---------------------------------------------------------------------------

interface BuildModelOpts {
  model: PrismaModel;
  modelNames: Set<string>;
  enumNames: Set<string>;
  storageSystem: "postgresql" | "mysql" | "sqlite";
  scope: string;
  sourceFile: string;
  /**
   * The implicit join table each many-to-many field writes through, keyed
   * `<model>.<field>`.
   */
  joinContainerByField: Map<string, string>;
}

function buildModelSummary(opts: BuildModelOpts): BehavioralSummary {
  const columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    primary?: boolean;
    unique?: boolean;
    derived?: boolean;
    joinContainer?: string;
  }> = [];
  const indexes: Array<{ fields: string[]; unique: boolean }> = [];
  const physicalTable = physicalTableOf(opts.model);

  let hasRelation = false;
  for (const property of opts.model.properties) {
    if ((property as { type: string }).type === "field") {
      const field = property as PrismaField;
      const column = fieldToColumn(field, opts.modelNames, opts.enumNames);
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

/**
 * Scalar and enum fields are columns. A relation field is not, and
 * neither is any array field.
 */
function fieldToColumn(
  field: PrismaField,
  modelNames: Set<string>,
  enumNames: Set<string>,
): {
  name: string;
  type: string;
  nullable: boolean;
  primary?: boolean;
  unique?: boolean;
} | null {
  if (field.array === true) {
    // Every array field is taken as a relation list, so `String[]` is
    // dropped as well.
    return null;
  }
  const ft = field.fieldType;
  const isScalar = PRISMA_SCALARS.has(ft);
  const isEnum = enumNames.has(ft);
  const isRelation = modelNames.has(ft);
  if (isRelation) {
    return null;
  }
  if (!isScalar && !isEnum) {
    // `Unsupported(...)`, a composite type, or a typo. The field is
    // skipped so the reader never guesses.
    return null;
  }

  let primary = false;
  let unique = false;
  for (const attr of field.attributes ?? []) {
    if (attr.name === "id") {
      primary = true;
    } else if (attr.name === "unique") {
      unique = true;
    }
  }

  return {
    name: field.name,
    type: ft,
    nullable: field.optional === true,
    ...(primary ? { primary: true } : {}),
    ...(unique ? { unique: true } : {}),
  };
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
    const name = readStringArg(attr);
    if (name !== null) {
      return name;
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
  const fields = readArrayArg(attr);
  if (fields === null) {
    return null;
  }
  return { fields, unique: attr.name !== "index" };
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
