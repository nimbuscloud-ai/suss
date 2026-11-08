/**
 * Recognizes Prisma client calls and records each one as a storage
 * access on the model it reaches, with one more effect for each relation
 * the call reads or writes through.
 *
 * The typed path reads ts-morph nodes for `<receiver>.<model>.<method>()`
 * and checks the receiver by its type, or by where it was made when the
 * client was never generated and the type is `any`. The `$queryRaw` family is a
 * `@suss/recognize` declaration. The README covers which methods count,
 * where the fields come from, and how a relation reaches the checker.
 */

import fs from "node:fs";
import path from "node:path";

import {
  type CallExpression,
  Node as N,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
} from "ts-morph";
import { z } from "zod";

import {
  parameterNamedBy,
  receiverTypesOf,
  writtenNodeOf,
} from "@suss/adapter-typescript";
import { storageBinding } from "@suss/behavioral-ir";
import { scopeOption, storageSystemOption } from "@suss/extractor";
import {
  compile,
  declarationsIn,
  declaredBy,
  slotsDeclared,
  sqlStatements,
} from "@suss/recognize";

import {
  generatedClientDirs,
  generatedClientInputs,
  isInGeneratedClient,
  schemaStorageSystem,
} from "./generatedClient.js";

import type { ReceiverType, ResolutionStore } from "@suss/adapter-typescript";
import type { Effect } from "@suss/behavioral-ir";
import type { PrismaStorageSystem } from "@suss/contract-prisma";
import type {
  CallOps,
  InvocationRecognizer,
  PatternPack,
  ValueOps,
} from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";
import type {
  DeclaredSlots,
  SlotColumns,
  SqlMethod,
  SqlStatements,
} from "@suss/recognize";

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

/**
 * A call picks rows by the values under `where` and writes the ones
 * under a payload key. A read's `select` lists columns as `true`, which
 * says nothing about where a value came from, so a read states only
 * its selector's.
 */
const PRISMA_SLOTS: DeclaredSlots = {
  selector: [["where"]],
  field: WRITE_PAYLOAD_KEYS.map((key) => [key]),
  fieldsOn: ["write"],
};

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
     * The storage system the calls target. When unset, the project
     * schema's datasource decides, then `"postgresql"`. The README says
     * why it has to match the schema reader's summaries.
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
  const scope = opts.scope ?? "default";
  return (call, ctx) =>
    recognizePrismaCall(
      call,
      ctx,
      storageSystemFor(opts, (call as Node).getSourceFile()),
      scope,
    );
}

/**
 * An option wins. Otherwise the datasource of the schema in the calling
 * file's project decides, so two projects on different databases stay apart.
 */
function storageSystemFor(
  opts: PrismaRecognizerOptions,
  file: SourceFile,
): PrismaStorageSystem {
  return (
    opts.storageSystem ??
    schemaStorageSystem(path.dirname(file.getFilePath())) ??
    DEFAULT_STORAGE_SYSTEM
  );
}

const DEFAULT_STORAGE_SYSTEM: PrismaStorageSystem = "postgresql";

function recognizePrismaCall(
  call: unknown,
  ctx: unknown,
  storageSystem: "postgresql" | "mysql" | "sqlite",
  scope: string,
): Effect[] | null {
  const callNode = call as CallExpression;
  const recognizerCtx = ctx as {
    resolution?: ResolutionStore;
    ops: CallOps;
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
  if (!isPrismaClientReceiver(receiverExpr, recognizerCtx.resolution)) {
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
  const given = recognizerCtx.ops.valueAt(0);
  const options = objectOf(given);
  const fields = extractFields(options, kind);
  const selector = extractSelector(options);
  const binding = storageBinding({
    recognition: "@suss/framework-prisma",
    storageSystem,
    scope,
    container: tableName,
  });
  const callee = callNode.getExpression().getText();
  const access: Effect = {
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
  };
  statePayloadSlots(recognizerCtx.ops, given, access, {
    selector: selector ?? [],
    fields,
    kind,
  });

  return [
    access,
    ...nestedReads(options).map(
      (nested): Effect => ({
        type: "interaction",
        binding,
        callee,
        interaction: {
          class: "storage-access",
          kind: "read",
          fields: nested.fields,
          ...(nested.selector === undefined
            ? {}
            : { selector: nested.selector }),
          relationPath: nested.relationPath,
          operation: method,
        },
      }),
    ),
    ...nestedWrites(options).map(
      (nested): Effect => ({
        type: "interaction",
        binding,
        callee,
        interaction: {
          class: "storage-access",
          kind: nested.lookup === true ? "read" : "write",
          fields: nested.fields,
          ...(nested.selector === undefined
            ? {}
            : { selector: nested.selector }),
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

/**
 * Tell the adapter which value the call states for each column it picks
 * by under `where` and each one it writes under a payload key, so the
 * summary can say where those values came from.
 */
function statePayloadSlots(
  ops: CallOps,
  given: ValueOps | null,
  effect: Effect,
  columns: SlotColumns,
): void {
  if (ops.statesSlots === undefined) {
    return;
  }
  const slots = slotsDeclared(given, PRISMA_SLOTS, columns);
  if (slots.length > 0) {
    ops.statesSlots(effect, slots);
  }
}

interface NestedRead {
  relationPath: string[];
  fields: string[];
  /** The columns the read picks the related rows by. */
  selector?: string[];
}

/**
 * The call shows a relation and never the model behind it, so each read
 * is recorded with the relation path it was written under, at any depth.
 * The checker resolves that path against the model's contract.
 */
function nestedReads(options: ValueOps | null): NestedRead[] {
  if (options === null) {
    return [];
  }
  const found: NestedRead[] = [];
  collectRelations(options, [], found);
  const where = objectOf(options.property("where"));
  if (where !== null) {
    columnsPickedBy(where, [], found);
  }
  return found;
}

/**
 * `include` takes only relations, so every key under it is one. `select`
 * takes a column as `true` and a relation as an object, so only the
 * objects are relations.
 */
function collectRelations(
  shape: ValueOps,
  path: string[],
  found: NestedRead[],
): void {
  const select = objectOf(shape.property("select"));
  if (select !== null) {
    for (const [name, value] of entriesOf(select)) {
      const nested = objectOf(value);
      if (nested === null) {
        continue;
      }
      recordRelation(name, nested, path, found);
    }
  }
  const include = objectOf(shape.property("include"));
  if (include === null) {
    return;
  }
  for (const [name, value] of entriesOf(include)) {
    const nested = objectOf(value);
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
  nested: ValueOps,
  path: string[],
  found: NestedRead[],
): void {
  const relationPath = [...path, name];
  const where = objectOf(nested.property("where"));
  const filtered: NestedRead[] = [];
  const selector =
    where === null ? [] : columnsPickedBy(where, relationPath, filtered);
  found.push({
    relationPath,
    fields: extractFields(nested, "read"),
    ...(selector.length > 0 ? { selector } : {}),
  });
  found.push(...filtered);
  collectRelations(nested, relationPath, found);
}

interface NestedWrite {
  relationPath: string[];
  fields: string[];
  operation: string;
  /** The columns the operation picks the related rows by. */
  selector?: string[];
  /**
   * Set when the operation only looks the related rows up by its
   * selector, to join them, and writes nothing across the relation.
   */
  lookup?: true;
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
  rows: ValueOps[];
}

type ReadWrittenRows = (payload: ValueOps | null) => WrittenRows;

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
    const rows: ValueOps[] = [];
    let written = outer.written && outer.rows.length > 0;
    for (const entry of outer.rows) {
      for (const key of keys) {
        const inner = objectsIn(entry.property(key));
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
  const statesData = outer.rows.some((row) => row.property("data") !== null);
  return statesData ? rowsUnder("data")(payload) : rowIsPayload(payload);
};

/** A deleted row fills no column and changes all of them. */
const wholeRow: ReadWrittenRows = () => ({ fields: ["*"], rows: [] });

/** The columns a nested operation picks the related rows by. */
type ReadPicked = (payload: ValueOps | null) => string[];

/** For `connectOrCreate: { where, create }` or a list of those. */
const pickedUnderWhere: ReadPicked = (payload) =>
  keysOfRows(
    objectsIn(payload).rows.flatMap(
      (row) => objectsIn(row.property("where")).rows,
    ),
  );

/** For `connect: { id }` or a list of those, the payload is the `where`. */
const pickedByPayload: ReadPicked = (payload) =>
  keysOfRows(objectsIn(payload).rows);

/** Only the `{ where, data }` form of a nested update picks its rows. */
const pickedByUpdate: ReadPicked = (payload) => {
  const statesData = objectsIn(payload).rows.some(
    (row) => row.property("data") !== null,
  );
  return statesData ? pickedUnderWhere(payload) : [];
};

interface NestedOperation {
  rows?: ReadWrittenRows;
  picks?: ReadPicked;
  /**
   * Joining a row, or creating one under the relation, sets the foreign
   * key, on whichever side declares it.
   */
  movesJoin?: true;
}

/**
 * `connect: { id }` selects the row to join by `id` and sets a foreign
 * key whose column depends on the schema, so the checker reads that
 * column from the contract. A delete changes every column of its row.
 */
const NESTED_OPERATIONS = new Map<string, NestedOperation>([
  ["create", { rows: rowIsPayload, movesJoin: true }],
  ["createMany", { rows: rowsUnder("data"), movesJoin: true }],
  [
    "connectOrCreate",
    { rows: rowsUnder("create"), picks: pickedUnderWhere, movesJoin: true },
  ],
  ["update", { rows: updateRow, picks: pickedByUpdate }],
  ["updateMany", { rows: rowsUnder("data"), picks: pickedUnderWhere }],
  [
    "upsert",
    {
      rows: rowsUnder("create", "update"),
      picks: pickedUnderWhere,
      movesJoin: true,
    },
  ],
  ["delete", { rows: wholeRow, picks: pickedByPayload }],
  ["deleteMany", { rows: wholeRow, picks: pickedByPayload }],
  ["connect", { picks: pickedByPayload, movesJoin: true }],
  ["disconnect", { picks: pickedByPayload, movesJoin: true }],
  ["set", { picks: pickedByPayload, movesJoin: true }],
]);

/**
 * Each write through a relation is recorded with its relation path, at
 * any depth, and the checker resolves the path the same way it does for
 * a nested read.
 */
function nestedWrites(options: ValueOps | null): NestedWrite[] {
  if (options === null) {
    return [];
  }
  const found: NestedWrite[] = [];
  for (const key of WRITE_PAYLOAD_KEYS) {
    for (const row of objectsIn(options.property(key)).rows) {
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
  row: ValueOps,
  path: string[],
  found: NestedWrite[],
): void {
  for (const [field, value] of entriesOf(row)) {
    const nested = objectOf(value);
    if (nested === null) {
      continue;
    }
    const relationPath = [...path, field];
    for (const [operation, payload] of entriesOf(nested)) {
      const does = NESTED_OPERATIONS.get(operation);
      if (does === undefined) {
        continue;
      }
      const selector = does.picks?.(payload) ?? [];
      const picked = selector.length > 0 ? { selector } : {};
      if (does.rows !== undefined) {
        const written = does.rows(payload);
        found.push({
          relationPath,
          fields: written.fields,
          operation,
          ...picked,
        });
        for (const deeper of written.rows) {
          collectNestedWrites(deeper, relationPath, found);
        }
      }
      // A join reads the rows it joins to find them, and the key it then
      // writes belongs to whichever side declares it, so the rows' own
      // columns go on an effect of their own.
      if (does.rows === undefined && selector.length > 0) {
        found.push({
          relationPath,
          fields: [],
          operation,
          ...picked,
          lookup: true,
        });
      }
      if (does.movesJoin === true) {
        found.push({ relationPath, fields: [], operation, relationKey: true });
      }
    }
  }
}

/**
 * The rows a payload writes: the payload itself, or each item of its
 * list. `written` is false when the payload, or any item of its list, is
 * not an object.
 */
function objectsIn(value: ValueOps | null): {
  rows: ValueOps[];
  written: boolean;
} {
  const object = objectOf(value);
  if (object !== null) {
    return { rows: [object], written: true };
  }
  const items = value?.items() ?? [];
  const rows = items.flatMap((item) => objectOf(item) ?? []);
  return { rows, written: items.length > 0 && rows.length === items.length };
}

/** Every key the rows state, in the order each was first written. */
function keysOfRows(rows: ValueOps[]): string[] {
  return [...new Set(rows.flatMap(keysOf))];
}

function fieldsOfRows(read: { rows: ValueOps[]; written: boolean }): string[] {
  if (!read.written) {
    return ["*"];
  }
  const out = keysOfRows(read.rows);
  return out.length === 0 ? ["*"] : out;
}

/**
 * The object a value is, or null. `object()` follows a name, and a call
 * that hands back its argument, to the object written there. It gives
 * nothing for a project function that builds an object and returns it,
 * which `entries()` does read, so a value with entries is an object as
 * well. The ops over ts-morph nodes have no `object()`, and for them
 * that is the only test.
 */
function objectOf(value: ValueOps | null): ValueOps | null {
  if (value === null) {
    return null;
  }
  const object = value.object?.() ?? null;
  if (object !== null) {
    return object;
  }
  return value.entries("nothing").length > 0 ? value : null;
}

/** The entries of an object whose key the source settles, in source order. */
function entriesOf(object: ValueOps): [string, ValueOps][] {
  return object
    .entries("nothing")
    .flatMap((entry): [string, ValueOps][] =>
      entry.key === null ? [] : [[entry.key, entry.value]],
    );
}

function keysOf(object: ValueOps): string[] {
  return entriesOf(object).map(([key]) => key);
}

/**
 * Checks the receiver's type, so `const db = new PrismaClient()`, a
 * wrapped `ctx.prisma` and a project's `class PrismaService extends
 * PrismaClient` all count. `isPrismaClientPath` lists the places the
 * type may be declared. When the type is `any`, as it is before
 * `prisma generate` has run, the store says where the receiver was made.
 */
function isPrismaClientReceiver(
  node: Node,
  resolution: ResolutionStore | undefined,
): boolean {
  if (
    receiverTypesOf(node).some(
      (type) =>
        declaredByPrisma(type) || extendsImportedClient(type, resolution),
    )
  ) {
    return true;
  }
  return (
    node.getType().isAny() &&
    (madeFromImportedClient(node, resolution) ||
      isTransactionClient(node, resolution))
  );
}

/**
 * Whether the value is the client `prisma.$transaction(async (tx) => ...)`
 * hands its callback, which is a client wherever the call's receiver is.
 */
function isTransactionClient(
  node: Node,
  resolution: ResolutionStore | undefined,
): boolean {
  const callback = callbackGiven(node);
  return (
    callback !== null &&
    transactionsRunning(callback, resolution).some((call) =>
      isPrismaClientReceiver(
        (call.getExpression() as PropertyAccessExpression).getExpression(),
        resolution,
      ),
    )
  );
}

/** The function whose first parameter this name is, or null. */
function callbackGiven(node: Node): Node | null {
  const parameter = parameterNamedBy(node);
  if (parameter === null) {
    return null;
  }
  const func = parameter.getParent();
  if (
    !N.isArrowFunction(func) &&
    !N.isFunctionExpression(func) &&
    !N.isFunctionDeclaration(func)
  ) {
    return null;
  }
  return func.getParameters()[0] === parameter ? func : null;
}

/**
 * The `$transaction` calls that run this function: the one it is written
 * in, or each one the store finds its name passed to.
 */
function transactionsRunning(
  func: Node,
  resolution: ResolutionStore | undefined,
): CallExpression[] {
  const inPlace = transactionTaking(func);
  if (inPlace !== null) {
    return [inPlace];
  }
  const declaration = declarationNaming(func);
  if (resolution === undefined || declaration === null) {
    return [];
  }
  return resolution.referencesTo(declaration).flatMap((reference) => {
    const call = transactionTaking(reference);
    return call === null ? [] : [call];
  });
}

/** The `<receiver>.$transaction(...)` call that takes this node first, or null. */
function transactionTaking(node: Node): CallExpression | null {
  const call = node.getParent();
  if (
    call === undefined ||
    !N.isCallExpression(call) ||
    call.getArguments()[0] !== node
  ) {
    return null;
  }
  const callee = call.getExpression();
  return N.isPropertyAccessExpression(callee) &&
    callee.getName() === TRANSACTION_METHOD
    ? call
    : null;
}

/** What a name for this function is declared as: the function itself, or the variable it is assigned to. */
function declarationNaming(func: Node): Node | null {
  if (N.isFunctionDeclaration(func)) {
    return func;
  }
  // A function is a variable declaration's child only as its initializer.
  const holder = func.getParent();
  return holder !== undefined && N.isVariableDeclaration(holder)
    ? holder
    : null;
}

const TRANSACTION_METHOD = "$transaction";

/**
 * Whether the value is a `PrismaClient` made from `@prisma/client`, or
 * from a client the schema's generator writes into the project.
 */
function madeFromImportedClient(
  node: Node,
  resolution: ResolutionStore | undefined,
): boolean {
  if (resolution === undefined) {
    return false;
  }
  if (importedAsClient(node, resolution)) {
    return true;
  }
  // The store traces an import only as far as the import declaration,
  // so a client another file makes is asked about where it is written.
  const written = writtenNodeOf(node, resolution);
  return (
    written !== null &&
    written !== node &&
    importedAsClient(written, resolution)
  );
}

/** Whether the value comes down to the `PrismaClient` a client module exports. */
function importedAsClient(value: Node, resolution: ResolutionStore): boolean {
  return resolution
    .importOriginsOf(value, clientModulesFor(value))
    .some((origin) => origin.path.join(".") === CLIENT_CLASS);
}

/**
 * `@prisma/client`, and every directory a generator of the value's own
 * project writes the client to.
 */
function clientModulesFor(value: Node): string[] {
  return [
    CLIENT_MODULE,
    ...generatedClientDirs(path.dirname(value.getSourceFile().getFilePath())),
  ];
}

function declaredByPrisma(type: ReceiverType): boolean {
  return type.declaredIn.some((filePath) => isPrismaClientPath(filePath));
}

const CLIENT_MODULE = "@prisma/client";

const CLIENT_CLASS = "PrismaClient";

/**
 * Without the client installed the checker cannot see past a project's
 * `class Db extends PrismaClient`, so the store says where the base was
 * imported from instead.
 */
function extendsImportedClient(
  type: ReceiverType,
  resolution: ResolutionStore | undefined,
): boolean {
  if (resolution === undefined) {
    return false;
  }
  return type.extendsWritten.some((base) => importedAsClient(base, resolution));
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
  return fs.existsSync(beside) || isInGeneratedClient(filePath);
}

function capitalizeFirst(name: string): string | null {
  if (name.length === 0) {
    return null;
  }
  return name[0].toUpperCase() + name.slice(1);
}

function extractFields(
  options: ValueOps | null,
  kind: "read" | "write",
): string[] {
  if (options === null) {
    return ["*"];
  }
  if (kind === "read") {
    const select = objectOf(options.property("select"));
    if (select === null) {
      // With no `select`, Prisma returns every column of the record, and
      // an `include` only adds relations beside it.
      return ["*"];
    }
    const include = objectOf(options.property("include"));
    return [
      ...new Set([
        ...keysOf(select),
        ...(include === null ? [] : keysOf(include)),
      ]),
    ];
  }
  const stated = new Map<string, ValueOps>();
  for (const key of WRITE_PAYLOAD_KEYS) {
    const payload = objectOf(options.property(key));
    if (payload === null) {
      continue;
    }
    for (const [name, value] of entriesOf(payload)) {
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

function statesNestedOperations(value: ValueOps): boolean {
  const nested = objectOf(value);
  if (nested === null) {
    return false;
  }
  return keysOf(nested).some((key) => NESTED_OPERATIONS.has(key));
}

function extractSelector(options: ValueOps | null): string[] | null {
  const where = objectOf(options?.property("where") ?? null);
  const keys = where === null ? [] : columnsPickedBy(where, [], []);
  return keys.length > 0 ? keys : null;
}

/** Prisma's operators on the rows of a relation, each taking a `where` on the related model. */
const RELATION_FILTERS = new Set(["some", "every", "none", "is", "isNot"]);

/** Prisma's operators on the value of one column. */
const COLUMN_FILTERS = new Set([
  "equals",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "endsWith",
  "mode",
  "not",
  "search",
  "has",
  "hasEvery",
  "hasSome",
  "isEmpty",
  "isSet",
  "path",
  "string_contains",
  "string_starts_with",
  "string_ends_with",
  "array_contains",
  "array_starts_with",
  "array_ends_with",
]);

const LOGICAL_OPERATORS = new Set(["AND", "OR", "NOT"]);

/**
 * The columns a `where` picks rows by. A relation filter in it reads the
 * related rows by the columns it filters, and goes into `found` instead.
 */
function columnsPickedBy(
  where: ValueOps,
  path: string[],
  found: NestedRead[],
): string[] {
  const columns: string[] = [];
  for (const [key, value] of entriesOf(where)) {
    if (LOGICAL_OPERATORS.has(key)) {
      // `AND`, `OR` and `NOT` take one `where` or a list of them, on the
      // same rows, so their columns are this `where`'s own.
      for (const combined of objectsIn(value).rows) {
        columns.push(...columnsPickedBy(combined, path, found));
      }
      continue;
    }
    const filters = relationFiltersIn(value);
    if (filters === null) {
      columns.push(key);
      continue;
    }
    const relationPath = [...path, key];
    const deeper: NestedRead[] = [];
    const fields = [
      ...new Set(
        filters.flatMap((filter) =>
          columnsPickedBy(filter, relationPath, deeper),
        ),
      ),
    ];
    found.push({ relationPath, fields }, ...deeper);
  }
  return [...new Set(columns)];
}

/**
 * The `where`s a value puts on a relation's rows, or null when it filters
 * a column. Only the schema tells a relation from a column, so an object
 * of anything but column operators is read as a relation's `where`.
 */
function relationFiltersIn(value: ValueOps): ValueOps[] | null {
  const filter = objectOf(value);
  if (filter === null) {
    return null;
  }
  const entries = entriesOf(filter);
  const keys = entries.map(([key]) => key);
  if (keys.length === 0 || keys.every((k) => COLUMN_FILTERS.has(k))) {
    return null;
  }
  if (!keys.some((k) => RELATION_FILTERS.has(k))) {
    return [filter];
  }
  return entries.flatMap(([k, inner]) => {
    const where = RELATION_FILTERS.has(k) ? objectOf(inner) : null;
    return where === null ? [] : [where];
  });
}

// A tagged template is a call whose one argument is the template, so the
// tagged and unsafe forms both have the statement first.
const STATEMENT: SqlMethod = { statement: { at: 0 } };

/**
 * A raw call bypasses the typed client, so the statement text is the only
 * place its tables show up. The method has to be declared under
 * `.prisma/client` or `@prisma/client`.
 */
function rawStatements(
  options: PrismaRecognizerOptions,
  provider: PrismaStorageSystem,
): SqlStatements {
  // Prisma's provider sets both the store and the SQL dialect, so one
  // value covers both.
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
 * A raw statement binds to the same database as a typed call in its file,
 * so the chain is compiled once for each system a project may use.
 */
function rawRecognizer(options: PrismaRecognizerOptions): InvocationRecognizer {
  const bySystem = new Map<PrismaStorageSystem, InvocationRecognizer>();
  return (call, ctx) => {
    const system = storageSystemFor(options, (call as Node).getSourceFile());
    let recognizer = bySystem.get(system);
    if (recognizer === undefined) {
      recognizer = compile(
        rawStatements(options, system).declared,
        "@suss/framework-prisma",
      );
      bySystem.set(system, recognizer);
    }
    return recognizer(call, ctx);
  };
}

/**
 * The pack discovers no units. A Prisma call becomes an effect inside a
 * handler or service that another pack discovered.
 */
export function prismaFramework(
  options: PrismaRecognizerOptions = {},
): PatternPack {
  const raw = rawStatements(
    options,
    options.storageSystem ?? DEFAULT_STORAGE_SYSTEM,
  );
  return {
    name: "prisma",
    version: "7",
    protocol: "in-process",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    // The type check would reject every call in a file that does not
    // import `@prisma/client`, so those files are skipped.
    requiresImport: ["@prisma/client"],
    // A generator with its own `output` puts the client in the project,
    // where the only way to reach it is a relative path. Prisma 7's
    // `prisma-client` generator writes no schema beside it.
    generatedModuleMarkers: [GENERATED_CLIENT_MARKER],
    generatedModuleDirs: generatedClientDirs,
    discoveryInputs: generatedClientInputs,
    invocationRecognizers: [makeRecognizer(options)],
    // A tagged template is not an invocation, so the raw chain runs on
    // the access walk, which visits calls as well.
    accessRecognizers: [rawRecognizer(options)],
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
