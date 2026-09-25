/**
 * Recognizes Prisma client calls and records each one as a storage
 * access on the model it reaches, with one more effect for each relation
 * the call reads or writes through.
 *
 * The typed path reads ts-morph nodes for `<receiver>.<model>.<method>()`
 * and checks the receiver by its type. The `$queryRaw` family is a
 * `@suss/recognize` declaration. The README covers which methods count,
 * where the fields come from, and how a relation reaches the checker.
 */

import fs from "node:fs";
import path from "node:path";

import {
  type CallExpression,
  Node as N,
  type Node,
  type SourceFile,
} from "ts-morph";
import { z } from "zod";

import { receiverTypeMatching } from "@suss/adapter-typescript";
import { storageBinding } from "@suss/behavioral-ir";
import { scopeOption, storageSystemOption } from "@suss/extractor";
import {
  compile,
  declarationsIn,
  declaredBy,
  sqlStatements,
} from "@suss/recognize";

import type { Effect } from "@suss/behavioral-ir";
import type {
  EffectArg,
  InvocationRecognizer,
  PatternPack,
} from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";
import type { SqlMethod, SqlStatements } from "@suss/recognize";

const PRISMA_READ_METHODS = new Set([
  "findUnique",
  "findFirst",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

// An upsert passes both `create` and `update`, so a write reads all three.
const WRITE_PAYLOAD_KEYS = ["data", "create", "update"];

const PRISMA_WRITE_METHODS = new Set([
  "create",
  "update",
  "delete",
  "upsert",
  "createMany",
  "updateMany",
  "deleteMany",
]);

/**
 * The options a `-f prisma=config.json` file may set. The CLI checks
 * the file against this schema before it calls the factory.
 */
export const optionsSchema = z
  .object({
    /**
     * The storage system the calls target, `"postgresql"` when unset. It
     * has to match the `storageSystem` on the schema reader's summaries,
     * or the calls do not pair.
     */
    storageSystem: storageSystemOption.optional(),
    /**
     * Has to match the schema reader's scope. It is `"default"` when
     * unset, the same default `prismaSchemaToSummaries` uses.
     */
    scope: scopeOption.optional(),
  })
  .strict();

export type PrismaRecognizerOptions = z.infer<typeof optionsSchema>;

function makeRecognizer(opts: PrismaRecognizerOptions): InvocationRecognizer {
  const storageSystem = opts.storageSystem ?? "postgresql";
  const scope = opts.scope ?? "default";
  return (call, ctx) => recognizePrismaCall(call, ctx, storageSystem, scope);
}

function recognizePrismaCall(
  call: unknown,
  ctx: unknown,
  storageSystem: "postgresql" | "mysql" | "sqlite",
  scope: string,
): Effect[] | null {
  const callNode = call as CallExpression;
  const recognizerCtx = ctx as {
    sourceFile: SourceFile;
    extractArgs: () => EffectArg[];
  };

  // The callee has to be `<receiver>.<delegate>.<method>`.
  const calleeExpr = callNode.getExpression();
  if (!N.isPropertyAccessExpression(calleeExpr)) {
    return null;
  }
  const delegateExpr = calleeExpr.getExpression();
  if (!N.isPropertyAccessExpression(delegateExpr)) {
    return null;
  }
  const method = calleeExpr.getName();
  const isRead = PRISMA_READ_METHODS.has(method);
  const isWrite = PRISMA_WRITE_METHODS.has(method);
  if (!isRead && !isWrite) {
    return null;
  }

  const receiverExpr = delegateExpr.getExpression();
  if (!isPrismaClientReceiver(receiverExpr)) {
    return null;
  }

  // Prisma lowercases the first letter of the model for the delegate
  // (`db.user` for `model User`). Capitalizing it again gives the name
  // the schema reader pairs on.
  const delegateName = delegateExpr.getName();
  const tableName = capitalizeFirst(delegateName);
  if (tableName === null) {
    return null;
  }

  const kind: "read" | "write" = isRead ? "read" : "write";
  const argsShape = recognizerCtx.extractArgs();
  const optionsArg = readObjectArg(argsShape[0]);
  const fields = extractFields(optionsArg, kind);
  const selector = extractSelector(optionsArg);
  const binding = storageBinding({
    recognition: "@suss/framework-prisma",
    storageSystem,
    scope,
    container: tableName,
  });
  const callee = callNode.getExpression().getText();

  return [
    {
      type: "interaction",
      binding,
      callee,
      interaction: {
        class: "storage-access",
        kind,
        fields,
        ...(selector !== null ? { selector } : {}),
        operation: method,
      },
    },
    ...nestedReads(optionsArg).map(
      (nested): Effect => ({
        type: "interaction",
        binding,
        callee,
        interaction: {
          class: "storage-access",
          kind: "read",
          fields: nested.fields,
          relationPath: nested.relationPath,
          operation: method,
        },
      }),
    ),
    ...nestedWrites(optionsArg).map(
      (nested): Effect => ({
        type: "interaction",
        binding,
        callee,
        interaction: {
          class: "storage-access",
          kind: "write",
          fields: nested.fields,
          relationPath: nested.relationPath,
          ...(nested.relationKey === true ? { relationKey: true } : {}),
          // The outer method acts on the model in the binding. The model
          // across the relation gets the nested operation.
          operation: nested.operation,
        },
      }),
    ),
  ];
}

interface NestedRead {
  relationPath: string[];
  fields: string[];
}

/**
 * The call shows a relation and never the model behind it, so each read
 * is recorded with the relation path it was written under, at any depth.
 * The checker resolves that path against the model's contract.
 */
function nestedReads(optionsArg: ObjectArg | null): NestedRead[] {
  if (optionsArg === null) {
    return [];
  }
  const found: NestedRead[] = [];
  collectRelations(optionsArg, [], found);
  return found;
}

/**
 * `include` takes only relations, so every key under it is one. `select`
 * takes a column as `true` and a relation as an object, so only the
 * objects are relations.
 */
function collectRelations(
  shape: ObjectArg,
  path: string[],
  found: NestedRead[],
): void {
  const select = readObjectArg(shape.fields.select);
  if (select !== null) {
    for (const [name, value] of Object.entries(select.fields)) {
      const nested = readObjectArg(value);
      if (nested === null) {
        continue;
      }
      recordRelation(name, nested, path, found);
    }
  }
  const include = readObjectArg(shape.fields.include);
  if (include === null) {
    return;
  }
  for (const [name, value] of Object.entries(include.fields)) {
    const nested = readObjectArg(value);
    if (nested === null) {
      // `include: { comments: true }` returns whole records.
      found.push({ relationPath: [...path, name], fields: ["*"] });
      continue;
    }
    recordRelation(name, nested, path, found);
  }
}

function recordRelation(
  name: string,
  nested: ObjectArg,
  path: string[],
  found: NestedRead[],
): void {
  const relationPath = [...path, name];
  found.push({ relationPath, fields: extractFields(nested, "read") });
  collectRelations(nested, relationPath, found);
}

interface NestedWrite {
  relationPath: string[];
  fields: string[];
  operation: string;
  /**
   * Set when the columns written are the foreign key of the last
   * relation in the path. The call does not show that key, so the
   * checker fills it in from the contract.
   */
  relationKey?: true;
}

interface WrittenRows {
  /**
   * `["*"]` when the payload is not written out at the call, the same as
   * a top-level write whose `data` cannot be read.
   */
  fields: string[];
  /** Walked again for relations of their own. */
  rows: ObjectArg[];
}

type ReadWrittenRows = (payload: EffectArg | undefined) => WrittenRows;

/** For `create: { name: tag }` or a list of those, the payload is the row. */
const rowIsPayload: ReadWrittenRows = (payload) => {
  const read = objectsIn(payload);
  return { fields: fieldsOfRows(read), rows: read.rows };
};

/**
 * For an operation with the row one level down, as in `connectOrCreate:
 * { where, create: { name } }`. An upsert has a row under each of two
 * keys and can fill columns from either.
 */
function rowsUnder(...keys: string[]): ReadWrittenRows {
  return (payload) => {
    const outer = objectsIn(payload);
    const rows: ObjectArg[] = [];
    let written = outer.written && outer.rows.length > 0;
    for (const entry of outer.rows) {
      for (const key of keys) {
        const inner = objectsIn(entry.fields[key]);
        rows.push(...inner.rows);
        written = written && inner.written;
      }
    }
    return { fields: fieldsOfRows({ rows, written }), rows };
  };
}

/**
 * A nested `update` passes `{ where, data }` on a list relation and the
 * row itself on a single one, so a `data` key separates the two.
 */
const updateRow: ReadWrittenRows = (payload) => {
  const outer = objectsIn(payload);
  const statesData = outer.rows.some((row) => "data" in row.fields);
  return statesData ? rowsUnder("data")(payload) : rowIsPayload(payload);
};

/** A deleted row fills no column and changes all of them. */
const wholeRow: ReadWrittenRows = () => ({ fields: ["*"], rows: [] });

interface NestedOperation {
  rows?: ReadWrittenRows;
  /**
   * Changing which row is joined sets the foreign key, on whichever side
   * declares it.
   */
  movesJoin?: true;
}

/**
 * `connect: { id }` selects the row to join by `id` and sets a foreign
 * key whose column depends on the schema, so the checker reads that
 * column from the contract. A delete changes every column of its row.
 */
const NESTED_OPERATIONS = new Map<string, NestedOperation>([
  ["create", { rows: rowIsPayload }],
  ["createMany", { rows: rowsUnder("data") }],
  ["connectOrCreate", { rows: rowsUnder("create"), movesJoin: true }],
  ["update", { rows: updateRow }],
  ["updateMany", { rows: rowsUnder("data") }],
  ["upsert", { rows: rowsUnder("create", "update") }],
  ["delete", { rows: wholeRow }],
  ["deleteMany", { rows: wholeRow }],
  ["connect", { movesJoin: true }],
  ["disconnect", { movesJoin: true }],
  ["set", { movesJoin: true }],
]);

/**
 * Each write through a relation is recorded with its relation path, at
 * any depth, and the checker resolves the path the same way it does for
 * a nested read.
 */
function nestedWrites(optionsArg: ObjectArg | null): NestedWrite[] {
  if (optionsArg === null) {
    return [];
  }
  const found: NestedWrite[] = [];
  for (const key of WRITE_PAYLOAD_KEYS) {
    for (const row of objectsIn(optionsArg.fields[key]).rows) {
      collectNestedWrites(row, [], found);
    }
  }
  return found;
}

/**
 * An object under a row key can be a relation's operations or a
 * structured column value, and the code alone cannot separate them. The
 * checker drops any path the contract does not declare as a relation.
 */
function collectNestedWrites(
  row: ObjectArg,
  path: string[],
  found: NestedWrite[],
): void {
  for (const [field, value] of Object.entries(row.fields)) {
    const nested = readObjectArg(value);
    if (nested === null) {
      continue;
    }
    const relationPath = [...path, field];
    for (const [operation, payload] of Object.entries(nested.fields)) {
      const does = NESTED_OPERATIONS.get(operation);
      if (does === undefined) {
        continue;
      }
      if (does.rows !== undefined) {
        const written = does.rows(payload);
        found.push({ relationPath, fields: written.fields, operation });
        for (const deeper of written.rows) {
          collectNestedWrites(deeper, relationPath, found);
        }
      }
      if (does.movesJoin === true) {
        found.push({ relationPath, fields: [], operation, relationKey: true });
      }
    }
  }
}

/**
 * `written` is false when the payload, or any item in its list, is not an
 * object literal.
 */
function objectsIn(arg: EffectArg | undefined): {
  rows: ObjectArg[];
  written: boolean;
} {
  const object = readObjectArg(arg);
  if (object !== null) {
    return { rows: [object], written: true };
  }
  if (
    arg === null ||
    arg === undefined ||
    typeof arg !== "object" ||
    arg.kind !== "array"
  ) {
    return { rows: [], written: false };
  }
  const rows: ObjectArg[] = [];
  let written = true;
  for (const item of arg.items) {
    const row = readObjectArg(item);
    if (row === null) {
      written = false;
      continue;
    }
    rows.push(row);
  }
  return { rows, written };
}

function fieldsOfRows(read: { rows: ObjectArg[]; written: boolean }): string[] {
  if (!read.written) {
    return ["*"];
  }
  const out = new Set<string>();
  for (const row of read.rows) {
    for (const key of Object.keys(row.fields)) {
      out.add(key);
    }
  }
  return out.size === 0 ? ["*"] : [...out];
}

/**
 * Checks the receiver's type, so `const db = new PrismaClient()`, a
 * wrapped `ctx.prisma` and a project's `class PrismaService extends
 * PrismaClient` all count. `isPrismaClientPath` lists the places the
 * type may be declared.
 */
function isPrismaClientReceiver(node: Node): boolean {
  return (
    receiverTypeMatching(node, { declaredIn: isPrismaClientPath }) !== null
  );
}

// Prisma copies the schema next to the generated client, wherever the
// generator wrote it.
const GENERATED_CLIENT_MARKER = "schema.prisma";

function isPrismaClientPath(filePath: string): boolean {
  if (
    filePath.includes("/@prisma/client/") ||
    filePath.includes("/.prisma/client/")
  ) {
    return true;
  }
  const beside = path.join(path.dirname(filePath), GENERATED_CLIENT_MARKER);
  return fs.existsSync(beside);
}

function capitalizeFirst(name: string): string | null {
  if (name.length === 0) {
    return null;
  }
  return name[0].toUpperCase() + name.slice(1);
}

interface ObjectArg {
  kind: "object";
  fields: Record<string, EffectArg>;
}

function readObjectArg(arg: EffectArg | undefined): ObjectArg | null {
  if (arg === null || arg === undefined) {
    return null;
  }
  if (typeof arg !== "object") {
    return null;
  }
  if ((arg as { kind?: string }).kind !== "object") {
    return null;
  }
  return arg as ObjectArg;
}

function extractFields(
  optionsArg: ObjectArg | null,
  kind: "read" | "write",
): string[] {
  if (optionsArg === null) {
    return ["*"];
  }
  if (kind === "read") {
    const select = readObjectArg(optionsArg.fields.select);
    const include = readObjectArg(optionsArg.fields.include);
    if (select === null) {
      // With no `select`, Prisma returns every column of the record, and
      // an `include` only adds relations beside it.
      return ["*"];
    }
    const out = new Set<string>();
    for (const k of Object.keys(select.fields)) {
      out.add(k);
    }
    if (include !== null) {
      for (const k of Object.keys(include.fields)) {
        out.add(k);
      }
    }
    return [...out];
  }
  const stated = new Map<string, EffectArg>();
  for (const propName of WRITE_PAYLOAD_KEYS) {
    const prop = readObjectArg(optionsArg.fields[propName]);
    if (prop === null) {
      continue;
    }
    for (const [name, value] of Object.entries(prop.fields)) {
      stated.set(name, value);
    }
  }
  if (stated.size === 0) {
    return ["*"];
  }
  const columns: string[] = [];
  for (const [name, value] of stated) {
    // A key with an operation under it goes across a relation. The
    // foreign key it changes is recorded by the nested write.
    if (statesNestedOperations(value)) {
      continue;
    }
    columns.push(name);
  }
  return columns;
}

function statesNestedOperations(value: EffectArg): boolean {
  const nested = readObjectArg(value);
  if (nested === null) {
    return false;
  }
  return Object.keys(nested.fields).some((key) => NESTED_OPERATIONS.has(key));
}

function extractSelector(optionsArg: ObjectArg | null): string[] | null {
  if (optionsArg === null) {
    return null;
  }
  const where = readObjectArg(optionsArg.fields.where);
  if (where === null) {
    return null;
  }
  const keys = Object.keys(where.fields);
  return keys.length > 0 ? keys : null;
}

// A tagged template is a call whose one argument is the template, so the
// tagged and unsafe forms both have the statement first.
const STATEMENT: SqlMethod = { statement: { at: 0 } };

/**
 * A raw call bypasses the typed client, so the statement text is the only
 * place its tables show up. The method has to be declared under
 * `.prisma/client` or `@prisma/client`.
 */
function rawStatements(options: PrismaRecognizerOptions): SqlStatements {
  // Prisma's provider sets both the store and the SQL dialect, so one
  // option covers both.
  const provider = options.storageSystem ?? "postgresql";
  return sqlStatements({
    system: provider,
    dialect: provider,
    scope: options.scope ?? "default",
    client: declaredBy("@prisma/client", ".prisma/client"),
  })
    .methods({
      $queryRaw: STATEMENT,
      $executeRaw: STATEMENT,
      $queryRawUnsafe: STATEMENT,
      $executeRawUnsafe: STATEMENT,
    })
    .example('prisma.$queryRawUnsafe("SELECT id, email FROM users")');
}

/**
 * The pack discovers no units. A Prisma call becomes an effect inside a
 * handler or service that another pack discovered.
 */
export function prismaFramework(
  options: PrismaRecognizerOptions = {},
): PatternPack {
  const raw = rawStatements(options);
  return {
    name: "prisma",
    protocol: "in-process",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    // The type check would reject every call in a file that does not
    // import `@prisma/client`, so those files are skipped.
    requiresImport: ["@prisma/client"],
    // A generator with its own `output` puts the client in the project,
    // where the only way to reach it is a relative path.
    generatedModuleMarkers: [GENERATED_CLIENT_MARKER],
    invocationRecognizers: [makeRecognizer(options)],
    // A tagged template is not an invocation, so the raw chain runs on
    // the access walk, which visits calls as well.
    accessRecognizers: [compile(raw.declared, "@suss/framework-prisma")],
    declarations: declarationsIn([raw]),
  };
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-prisma",
  dependencies: [{ ecosystem: "npm", name: "@prisma/client" }],
  reads:
    "Prisma client calls. Each read and each write becomes a storage-access interaction.",
};

export default prismaFramework;
