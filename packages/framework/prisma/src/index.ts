/**
 * Recognizes Prisma client calls and records each one as a storage
 * access on the model it reaches, with one more effect for each relation
 * the call reads or writes through.
 *
 * Both kinds of call are `@suss/recognize` declarations: the typed
 * client's `<client>.<model>.<method>()` and the `$queryRaw` family.
 * What a call's options say (its fields, its selector, the relations it
 * reads and writes through, a compound key) is read by the pack's own
 * rules over the value ops. The README covers which methods count, where
 * the fields come from, and how a relation reaches the checker.
 */

import path from "node:path";

import { z } from "zod";

import { scopeOption, storageSystemOption } from "@suss/extractor";
import {
  anyOf,
  constructedFrom,
  declaredBy,
  handedBy,
  inherits,
  pack,
  sqlStatements,
  storageCalls,
  typed,
} from "@suss/recognize";

import {
  generatedClientDirs,
  generatedClientInputs,
  schemaModels,
  schemaStorageSystem,
} from "./generatedClient.js";

import type {
  PrismaClientModel,
  PrismaStorageSystem,
} from "@suss/contract-prisma";
import type { PackDeclaration } from "@suss/ir-core";
import type {
  CallOps,
  CallStep,
  DeclaredSlots,
  OneArgument,
  PatternPack,
  RelatedAccess,
  SqlMethod,
  SqlStatements,
  StatedInputs,
  StorageCalls,
  StorageMethod,
  StorageSystem,
  ValueOps,
} from "@suss/recognize";

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

const DEFAULT_STORAGE_SYSTEM: PrismaStorageSystem = "postgresql";

/**
 * An option wins. Otherwise the datasource of the schema in the calling
 * file's project decides, so two projects on different databases stay apart.
 */
function storageSystemOf(options: PrismaRecognizerOptions): StorageSystem {
  return (
    options.storageSystem ?? {
      byFile: (file) => schemaStorageSystem(path.dirname(file)),
      otherwise: DEFAULT_STORAGE_SYSTEM,
    }
  );
}

const CLIENT_MODULE = "@prisma/client";

/**
 * `prisma generate` writes the client into `.prisma/client` unless the
 * schema says otherwise, and `@prisma/client` re-exports it from there.
 */
const CLIENT_MODULES = [CLIENT_MODULE, ".prisma/client"];

const CLIENT_CLASS = "PrismaClient";

/**
 * A Prisma client, however the file reached it: a value of a type the
 * client declares, one of a project class that extends `PrismaClient`,
 * or one made from `PrismaClient`, which is how a client reads before
 * `prisma generate` has run and its type is `any`.
 */
const CLIENT = anyOf(
  typed({ from: CLIENT_MODULES }),
  inherits({ from: CLIENT_MODULES, named: [CLIENT_CLASS] }),
  constructedFrom({ from: CLIENT_MODULES, named: [CLIENT_CLASS] }),
);

/**
 * The client, or the one `prisma.$transaction(async (tx) => ...)` hands
 * its callback, which is a client wherever the call's receiver is.
 */
const RECEIVER = anyOf(
  CLIENT,
  handedBy("$transaction", CLIENT, { parameter: 0 }),
);

/** `db.user` in `db.user.findMany()`, the delegate the client is one member read away from. */
const DELEGATE: CallStep = { to: "member" };

const OPTIONS: OneArgument = { at: 0 };

const READ: StorageMethod = {
  kind: "read",
  fields: { of: OPTIONS, by: fieldsRead },
  selector: { of: OPTIONS, by: columnsPicked },
};

const WRITE: StorageMethod = { ...READ, kind: "write" };

const METHODS: Readonly<Record<string, StorageMethod>> = {
  findUnique: READ,
  findUniqueOrThrow: READ,
  findFirst: READ,
  findFirstOrThrow: READ,
  findMany: READ,
  count: READ,
  aggregate: READ,
  groupBy: READ,
  create: WRITE,
  update: WRITE,
  delete: WRITE,
  upsert: WRITE,
  createMany: WRITE,
  updateMany: WRITE,
  deleteMany: WRITE,
};

/**
 * Every call on a model's delegate. Prisma lowercases the first letter
 * of the model for the delegate (`db.user` for `model User`), and
 * capitalizing it again gives the name the schema reader pairs on.
 */
function modelCalls(
  options: PrismaRecognizerOptions,
  system: StorageSystem,
): StorageCalls {
  return storageCalls({
    system,
    scope: options.scope ?? "default",
    client: RECEIVER,
    clientAt: [DELEGATE],
  })
    .methods(METHODS)
    .container({ of: [DELEGATE], naming: "upperFirst" })
    .relations({ of: OPTIONS, by: relatedAccesses })
    .slots(PRISMA_SLOTS)
    .example(
      "prisma.user.findMany({ where: { id: 1 }, select: { email: true } })",
    );
}

/** The columns a call reads or writes, as its options state them. */
function fieldsRead({ input, kind }: StatedInputs): string[] {
  return extractFields(objectOf(input), kind);
}

/** The columns a call picks its rows by, a compound key read as the columns it combines. */
function columnsPicked({ input, container, call }: StatedInputs): string[] {
  const keys = compoundKeysAt(modelsOf(container, call), []);
  return extractSelector(objectOf(input), keys) ?? [];
}

/**
 * Each read and each write a call makes through a relation, the reads
 * first. The outer method acts on the model in the binding, and a write
 * across the relation records its own nested operation.
 */
function relatedAccesses({
  input,
  container,
  call,
}: StatedInputs): RelatedAccess[] {
  const options = objectOf(input);
  const on = modelsOf(container, call);
  return [
    ...nestedReads(options, compoundKeysAt(on, [])).map(readAcross),
    ...nestedWrites(options, on).map(writeAcross),
  ];
}

function readAcross(nested: NestedRead): RelatedAccess {
  return {
    path: nested.relationPath,
    kind: "read",
    fields: nested.fields,
    ...(nested.selector === undefined ? {} : { selector: nested.selector }),
  };
}

function writeAcross(nested: NestedWrite): RelatedAccess {
  return {
    path: nested.relationPath,
    kind: nested.lookup === true ? "read" : "write",
    fields: nested.fields,
    operation: nested.operation,
    ...(nested.selector === undefined ? {} : { selector: nested.selector }),
    ...(nested.relationKey === true ? { relationKey: true } : {}),
  };
}

/** The models of the schema in the call's own project, and the one the call is made on. */
function modelsOf(container: string | null, call: CallOps): CallModels {
  const file = call.file?.() ?? null;
  return {
    models: file === null ? new Map() : schemaModels(path.dirname(file)),
    model: container ?? "",
  };
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
function nestedReads(
  options: ValueOps | null,
  keys: CompoundKeys,
): NestedRead[] {
  if (options === null) {
    return [];
  }
  const found: NestedRead[] = [];
  collectRelations(options, [], found);
  const where = objectOf(options.property("where"));
  if (where !== null) {
    columnsPickedBy(where, [], found, keys);
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
   * Set when the effect only reads the related rows: a lookup by the
   * selector that writes nothing across the relation, or a relation
   * filter in the operation's `where`.
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

/** The `where`s a nested operation picks the related rows by. */
type ReadWheres = (payload: ValueOps | null) => ValueOps[];

/** For `connectOrCreate: { where, create }` or a list of those. */
const wheresUnderKey: ReadWheres = (payload) =>
  objectsIn(payload).rows.flatMap(
    (row) => objectsIn(row.property("where")).rows,
  );

/** For `connect: { id }` or a list of those, the payload is the `where`. */
const payloadIsWhere: ReadWheres = (payload) => objectsIn(payload).rows;

/** Only the `{ where, data }` form of a nested update picks its rows. */
const wheresOfUpdate: ReadWheres = (payload) => {
  const statesData = objectsIn(payload).rows.some(
    (row) => row.property("data") !== null,
  );
  return statesData ? wheresUnderKey(payload) : [];
};

interface NestedOperation {
  rows?: ReadWrittenRows;
  picks?: ReadWheres;
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
    { rows: rowsUnder("create"), picks: wheresUnderKey, movesJoin: true },
  ],
  ["update", { rows: updateRow, picks: wheresOfUpdate }],
  ["updateMany", { rows: rowsUnder("data"), picks: wheresUnderKey }],
  [
    "upsert",
    {
      rows: rowsUnder("create", "update"),
      picks: wheresUnderKey,
      movesJoin: true,
    },
  ],
  ["delete", { rows: wholeRow, picks: payloadIsWhere }],
  ["deleteMany", { rows: wholeRow, picks: payloadIsWhere }],
  ["connect", { picks: payloadIsWhere, movesJoin: true }],
  ["disconnect", { picks: payloadIsWhere, movesJoin: true }],
  ["set", { picks: payloadIsWhere, movesJoin: true }],
]);

/**
 * Each write through a relation is recorded with its relation path, at
 * any depth, and the checker resolves the path the same way it does for
 * a nested read.
 */
function nestedWrites(options: ValueOps | null, on: CallModels): NestedWrite[] {
  if (options === null) {
    return [];
  }
  const found: NestedWrite[] = [];
  for (const key of WRITE_PAYLOAD_KEYS) {
    for (const row of objectsIn(options.property(key)).rows) {
      collectNestedWrites(row, [], found, on);
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
  on: CallModels,
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
      const filtered: NestedRead[] = [];
      const keys = compoundKeysAt(on, relationPath);
      const selector = [
        ...new Set(
          (does.picks?.(payload) ?? []).flatMap((where) =>
            columnsPickedBy(where, relationPath, filtered, keys),
          ),
        ),
      ];
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
          collectNestedWrites(deeper, relationPath, found, on);
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
      for (const read of filtered) {
        found.push({
          relationPath: read.relationPath,
          fields: read.fields,
          operation,
          lookup: true,
        });
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

function extractSelector(
  options: ValueOps | null,
  keys: CompoundKeys,
): string[] | null {
  const where = objectOf(options?.property("where") ?? null);
  const columns = where === null ? [] : columnsPickedBy(where, [], [], keys);
  return columns.length > 0 ? columns : null;
}

/**
 * The compound unique keys of one model, each with the columns it
 * combines, as in `where: { domain_key: { domain, key } }`. Null when the
 * schema does not declare the model.
 */
type CompoundKeys = ReadonlyMap<string, readonly string[]> | null;

/** Only the first level of a unique `where` can name a compound key. */
const NO_COMPOUND_KEYS: CompoundKeys = new Map();

/** The models of the project's schema, and the one a call is made on. */
interface CallModels {
  models: ReadonlyMap<string, PrismaClientModel>;
  model: string;
}

/** The compound keys of the model a relation path leads to from the call's model. */
function compoundKeysAt(on: CallModels, path: readonly string[]): CompoundKeys {
  return modelAt(on.models, on.model, path)?.compoundKeys ?? null;
}

/**
 * The columns a key combines, or null when it is not a compound key. The
 * schema decides when it declares the model. Otherwise a key is read as
 * one when it spells the keys of the object under it joined by `_`,
 * which is the name Prisma gives it unless the schema passes a `name`.
 */
function compoundKeyColumns(
  keys: CompoundKeys,
  key: string,
  value: ValueOps,
): string[] | null {
  if (keys === null) {
    return spelledCompoundKey(key, value);
  }
  const fields = keys.get(key);
  return fields === undefined ? null : [...fields];
}

function modelAt(
  models: ReadonlyMap<string, PrismaClientModel>,
  model: string,
  path: readonly string[],
): PrismaClientModel | null {
  return path.reduce<PrismaClientModel | null>((at, field) => {
    const next = at?.relations.get(field);
    return next === undefined ? null : (models.get(next) ?? null);
  }, models.get(model) ?? null);
}

function spelledCompoundKey(key: string, value: ValueOps): string[] | null {
  const inner = objectOf(value);
  const columns = inner === null ? [] : keysOf(inner);
  return columns.length > 1 && spellsColumns(key, columns) ? columns : null;
}

/** Whether the name is each of the columns once, in any order, joined by `_`. */
function spellsColumns(name: string, columns: readonly string[]): boolean {
  return columns.some((column, at) => {
    if (!name.startsWith(column)) {
      return false;
    }
    const rest = name.slice(column.length);
    const others = columns.filter((_, other) => other !== at);
    if (others.length === 0) {
      return rest === "";
    }
    return rest.startsWith("_") && spellsColumns(rest.slice(1), others);
  });
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
  keys: CompoundKeys = NO_COMPOUND_KEYS,
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
    const keyColumns = compoundKeyColumns(keys, key, value);
    if (keyColumns !== null) {
      columns.push(...keyColumns);
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
 * `.prisma/client` or `@prisma/client`. A raw statement binds to the same
 * database as a typed call in its file.
 */
function rawStatements(
  options: PrismaRecognizerOptions,
  system: StorageSystem,
): SqlStatements {
  // Prisma's provider sets both the store and the SQL dialect, so one
  // value covers both.
  return sqlStatements({
    system,
    dialect: system,
    scope: options.scope ?? "default",
    client: declaredBy(...CLIENT_MODULES),
  })
    .methods({
      $queryRaw: STATEMENT,
      $executeRaw: STATEMENT,
      $queryRawUnsafe: STATEMENT,
      $executeRawUnsafe: STATEMENT,
    })
    .example('prisma.$queryRawUnsafe("SELECT id, email FROM users")');
}

// Prisma copies the schema next to the generated client, wherever the
// generator wrote it.
const GENERATED_CLIENT_MARKER = "schema.prisma";

/**
 * The pack discovers no units. A Prisma call becomes an effect inside a
 * handler or service that another pack discovered.
 */
export function prismaFramework(
  options: PrismaRecognizerOptions = {},
): PatternPack {
  const system = storageSystemOf(options);
  return pack(
    "prisma",
    [modelCalls(options, system), rawStatements(options, system)],
    {
      languages: ["typescript", "javascript"],
      recognizedAs: "@suss/framework-prisma",
      version: "11",
      protocol: "in-process",
      // A generator with its own `output` puts the client in the project,
      // where no specifier spells the package. Prisma 7's `prisma-client`
      // generator writes no schema beside it.
      generatedModules: {
        of: CLIENT_MODULE,
        markers: [GENERATED_CLIENT_MARKER],
        dirs: generatedClientDirs,
      },
      discoveryInputs: generatedClientInputs,
    },
  );
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-prisma",
  dependencies: [{ ecosystem: "npm", name: "@prisma/client" }],
  reads:
    "Prisma client calls. Each read and each write becomes a storage-access interaction.",
};

export default prismaFramework;
