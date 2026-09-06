// @suss/contract-prisma: turn a Prisma schema into one
// `BehavioralSummary` per model with `storage` semantics.
//
// Parses `schema.prisma` via `@mrleebo/prisma-ast` (a stable parser
// that doesn't pull in Prisma's runtime). Emits one provider summary
// per model that the checker's `checkStorage` pass pairs
// against `interaction(class: "storage-access")` effects in code summaries.
//
// Out of scope for v0:
//   - MongoDB and other non-relational providers (skipped with a
//     warning; needs storage-document semantics).
//   - Composite types (Mongo) and views (Postgres), emit nothing
//     today; can be added later under the same boundary semantics.
//   - Relations between models, relation fields aren't columns. The FK
//     columns are, both as scalars and as the `relationKey` of the
//     relation field that owns them.

import fs from "node:fs";
import path from "node:path";

import { getSchema } from "@mrleebo/prisma-ast";

import { storageBinding } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export interface PrismaSchemaToSummariesOptions {
  /** Override the source-file path recorded on each summary. */
  source?: string;
  /**
   * Scope identifier: defaults to `"default"` for single-schema
   * projects. Monorepos with multiple Prisma schemas should pass
   * distinct values per schema so pairings stay separate.
   */
  scope?: string;
}

/**
 * Built-in Prisma scalar types. Anything in this set is a column;
 * anything outside it is either an enum (also a column, looked up
 * separately) or a relation (skipped).
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
 * Prisma datasource providers, by the store each one talks to. Prisma
 * takes both spellings of Postgres and the conventions take one.
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
 * Convert an in-memory Prisma schema source into `BehavioralSummary[]`.
 */
export function prismaSchemaToSummaries(
  source: string,
  options: PrismaSchemaToSummariesOptions = {},
): BehavioralSummary[] {
  const ast = getSchema(source);
  const list = (ast as { list: Array<unknown> }).list;

  // First pass: inventory model names + enum names + storage system.
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
    // No relational datasource: schema is for MongoDB or another
    // non-relational target. Emit nothing; future phases handle
    // storage-document.
    return [];
  }

  // Second pass: emit one summary per model / view, plus one per
  // implicit many-to-many join table the models declare between them.
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
 * One relation table Prisma manages itself, between two list fields
 * that point at each other with neither side declaring the foreign
 * key. An explicit join model already has a `@relation(fields: [...])`
 * on one of its own fields, so it never matches here.
 */
interface ImplicitManyToMany {
  leftModel: string;
  leftField: string;
  rightModel: string;
  rightField: string;
  relationName: string | null;
  joinTable: string;
}

/**
 * Every implicit many-to-many the schema declares, one entry per
 * relation regardless of which side it is read from.
 */
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
 * The list relation field on the other side of an implicit
 * many-to-many: same relation name (both unnamed counts as a match),
 * pointing back at this model, and never the field itself for a
 * self-relation.
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
 * What Prisma calls the table behind an implicit many-to-many: an
 * underscore plus the relation's own name when the schema gives one,
 * or an underscore plus the two model names in alphabetical order
 * joined by `To` when it does not.
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
 * The boundary for a join table Prisma creates and manages itself.
 * Its only columns are `A` and `B`, referencing the model whose name
 * sorts first and second, which is how the client's `connect`,
 * `disconnect` and `set` change a row here without naming either.
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
 * Convert a Prisma schema file on disk into `BehavioralSummary[]`.
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
  /** The implicit join table each many-to-many field writes through, keyed `<model>.<field>`. */
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
 * A field whose type is another model. The client takes it in an
 * `include` or a `select` even though no column of that name exists.
 * Leaving it out of a contract that calls itself exhaustive reports
 * working code as reading a field nobody declared.
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

/** The field's own `@relation(...)` attribute, or undefined without one. */
function relationAttributeOf(field: PrismaField): PrismaAttribute | undefined {
  return (field.attributes ?? []).find((attr) => attr.name === "relation");
}

/**
 * The columns listed in `@relation(fields: [...])`, which are the
 * foreign key this model stores. Prisma allows that argument on one
 * side of a relation only, so the other side and every implicit
 * many-to-many come back null: connecting a row there changes a
 * join-table entry and no column of this model.
 */
function relationKeyOf(field: PrismaField): string[] | null {
  const relation = relationAttributeOf(field);
  return relation === undefined ? null : readKeyedArrayArg(relation, "fields");
}

/**
 * The relation's own name from `@relation("Name", ...)`, or null when
 * the schema leaves the relation unnamed. Two list fields pointing at
 * each other need this to tell one many-to-many from another between
 * the same two models, and it is what the join table is called after.
 */
function relationNameOf(field: PrismaField): string | null {
  const relation = relationAttributeOf(field);
  return relation === undefined ? null : readStringArg(relation);
}

/**
 * Decide whether a field is a column we should record. Skips
 * relation fields (whose type is another model) and array fields
 * (relation arrays like `posts Post[]`). Captures attributes for
 * primary-key / unique flags.
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
    // `Post[]` is a relation list, not a column.
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
    // Unknown type: could be Unsupported(...), an unsupported
    // composite type, or a typo. Skip rather than guess.
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
 * The physical SQL table name from a model's `@@map("...")` block
 * attribute, or null when the model has none (in which case the
 * physical table IS the model name, Prisma's default). This is the
 * cross-tool pairing bridge: code that speaks SQL names directly
 * (Drizzle's `pgTable("users")`, raw SQL) matches a mapped model
 * through this channel.
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
 * Convert a block-level attribute (`@@index([...])`, `@@unique([...])`,
 * `@@id([...])`) into an index entry. Other block attributes
 * (`@@schema`) are ignored; `@@map` is read separately as the
 * physical table name.
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
 * The array under one named argument. A field attribute takes several
 * arguments and the position of each varies, so the name is the only
 * way to tell `fields` from `references`.
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
      // Parser keeps quotes: strip them.
      return a.value.replace(/^"|"$/g, "");
    }
  }
  return null;
}
