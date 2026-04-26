// @suss/contract-prisma — turn a Prisma schema into one
// `BehavioralSummary` per model with `storage-relational` semantics.
//
// Parses `schema.prisma` via `@mrleebo/prisma-ast` (a stable parser
// that doesn't pull in Prisma's runtime). Emits one provider summary
// per model that the checker's `checkRelationalStorage` pass pairs
// against `interaction(class: "storage-access")` effects in code summaries.
//
// Out of scope for v0:
//   - MongoDB and other non-relational providers (skipped with a
//     warning; needs storage-document semantics).
//   - Composite types (Mongo) and views (Postgres) — emit nothing
//     today; can be added later under the same boundary semantics.
//   - Relations between models — relation fields aren't columns
//     (the FK columns are; those ARE captured as scalars).

import fs from "node:fs";
import path from "node:path";

import { getSchema } from "@mrleebo/prisma-ast";

import { storageRelationalBinding } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export interface PrismaSchemaToSummariesOptions {
  /** Override the source-file path recorded on each summary. */
  source?: string;
  /**
   * Scope identifier — defaults to `"default"` for single-schema
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

/** Map Prisma datasource provider strings to our storageSystem enum. */
const PROVIDER_TO_SYSTEM: Record<string, "postgres" | "mysql" | "sqlite"> = {
  postgresql: "postgres",
  postgres: "postgres",
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
  let storageSystem: "postgres" | "mysql" | "sqlite" | null = null;

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
    // No relational datasource — schema is for MongoDB or another
    // non-relational target. Emit nothing; future phases handle
    // storage-document.
    return [];
  }

  // Second pass: emit one summary per model / view.
  const sourceFile = options.source ?? "schema.prisma";
  const scope = options.scope ?? "default";
  const summaries: BehavioralSummary[] = [];

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
      }),
    );
  }

  return summaries;
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
  storageSystem: "postgres" | "mysql" | "sqlite";
  scope: string;
  sourceFile: string;
}

function buildModelSummary(opts: BuildModelOpts): BehavioralSummary {
  const columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    primary?: boolean;
    unique?: boolean;
  }> = [];
  const indexes: Array<{ fields: string[]; unique: boolean }> = [];

  for (const property of opts.model.properties) {
    if ((property as { type: string }).type === "field") {
      const field = property as PrismaField;
      const column = fieldToColumn(field, opts.modelNames, opts.enumNames);
      if (column !== null) {
        columns.push(column);
      }
    } else if ((property as { type: string }).type === "attribute") {
      const attr = property as PrismaAttribute;
      const index = blockAttributeToIndex(attr);
      if (index !== null) {
        indexes.push(index);
      }
    }
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
      boundaryBinding: storageRelationalBinding({
        recognition: "prisma",
        storageSystem: opts.storageSystem,
        scope: opts.scope,
        table: opts.model.name,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: {
        columns,
        indexes,
      },
    },
  };
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
    // Unknown type — could be Unsupported(...), an unsupported
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
 * Convert a block-level attribute (`@@index([...])`, `@@unique([...])`,
 * `@@id([...])`) into an index entry. Other block attributes (`@@map`,
 * `@@schema`) are ignored.
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
    const value = arg.value as { type?: string; args?: unknown[] } | null;
    if (value === null || value === undefined) {
      continue;
    }
    if (value.type === "array" && Array.isArray(value.args)) {
      const out: string[] = [];
      for (const item of value.args) {
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
  }
  return null;
}

function readProviderString(ds: PrismaDatasource): string | null {
  for (const a of ds.assignments) {
    if (a.key !== "provider") {
      continue;
    }
    if (typeof a.value === "string") {
      // Parser keeps quotes — strip them.
      return a.value.replace(/^"|"$/g, "");
    }
  }
  return null;
}
