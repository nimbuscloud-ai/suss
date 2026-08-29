// @suss/framework-prisma: recognize Prisma client calls in TypeScript
// and emit `interaction(class: "storage-access")` effects on the
// transitions that contain them.
//
// Recognition is AST-based via ts-morph: walks the call's receiver
// chain back to its root identifier, resolves that identifier's type
// via the type checker, and verifies the type's symbol declaration is
// in `@prisma/client` (or `.prisma/client`: Prisma's generated
// client lives under `node_modules/.prisma/client/` for projects
// using the standard generator output).
//
// Three-segment chain: `<receiver>.<modelDelegate>.<method>(args)`.
// `<modelDelegate>` is the lowercase-first-letter Prisma client
// convention (`prisma.user` for `model User`); the recognizer reads
// the property NAME and capitalizes the first letter to recover the
// PascalCase schema model name. This matches the schema reader's
// (`@suss/contract-prisma`) output channel.
//
// Method classification:
//   read:   findUnique, findFirst, findMany, count, aggregate, groupBy
//   write:  create, update, delete, upsert, createMany, updateMany,
//           deleteMany
//
// Field extraction from the call's first arg (always an object literal
// for typed Prisma calls):
//   read:   `select` keys, plus `include` keys when a select says which
//           fields to return. A query with no `select` reads the whole
//           record, `include` or not, so it comes back as ["*"].
//   write:  union of `data`, `create`, `update` keys (an upsert can pass
//           both create and update). Falls back to ["*"] for shape-
//           less writes (rare; createMany with a dynamic body).
//   selector: keys of `where` (when present).
//
// A relation asked for beside the record is a read of another model,
// and the call says which relation without ever saying which model. So
// each one comes back as a second effect carrying `relationPath`, the
// relation fields it was written under, and the checker resolves that
// path against the model's contract to find the table it belongs to.
// A write does this too: a `create` with an `include` hands the
// relation back the way a query does, and a nested operation under
// `data` writes the model across the relation, per `NESTED_OPERATIONS`.
// An operation that moves a join sets a foreign key, so it arrives with
// `relationKey` and the checker fills the columns from the contract.
//
// Out of scope for v0:
//   - findUniqueOrThrow and findFirstOrThrow, which would be easy to add.

import {
  type CallExpression,
  Node as N,
  type Node,
  type SourceFile,
} from "ts-morph";

import { storageBinding } from "@suss/behavioral-ir";
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
import type { SqlMethod, SqlStatements } from "@suss/recognize";

const PRISMA_READ_METHODS = new Set([
  "findUnique",
  "findFirst",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

/** Where a write states the row values, an upsert stating two of them. */
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

export interface PrismaRecognizerOptions {
  /**
   * Storage system the recognized calls target. Must match the
   * `storageSystem` on schema-reader provider summaries; otherwise
   * pairing keys won't match. Defaults to `"postgresql"` since that's
   * the dominant Prisma deployment.
   */
  storageSystem?: "postgresql" | "mysql" | "sqlite";
  /**
   * Scope label that must match the schema reader's scope. Defaults
   * to `"default"` to align with `prismaSchemaToSummaries`'s default.
   */
  scope?: string;
}

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

  // Shape gate: callee must be `<receiver>.<delegate>.<method>` ,
  // a PropertyAccessExpression whose own expression is also a
  // PropertyAccessExpression.
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

  // Verify the delegate's receiver is a PrismaClient. The delegate
  // expression is `<receiver>.<delegate>` (e.g. `prisma.user` or
  // `ctx.prisma.user`); its `.getExpression()` is the receiver
  // (`prisma` / `ctx.prisma`). Check that receiver's TYPE: its
  // symbol declaration should live in `@prisma/client` /
  // `.prisma/client`.
  //
  // Checking the receiver's TYPE rather than its identifier symbol
  // covers both bare-instance receivers (`const db = new PrismaClient()`)
  // and wrapped-context receivers (`{ prisma: new PrismaClient() }.prisma`)
  //: the receiver expression's type is PrismaClient in both shapes.
  const receiverExpr = delegateExpr.getExpression();
  if (!isPrismaClientReceiver(receiverExpr)) {
    return null;
  }

  // Model name: the property accessed on PrismaClient (`db.user`) is
  // lowercase-first-letter per the Prisma client convention. The
  // schema model is PascalCase. Capitalize back so pairing matches
  // the schema reader's table channel.
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
          // What reaches the other model is the nested operation, so
          // that is what the effect records. The outer method belongs
          // to the model in the binding.
          operation: nested.operation,
        },
      }),
    ),
  ];
}

/** Fields a query asks for through a relation, and the relation. */
interface NestedRead {
  relationPath: string[];
  fields: string[];
}

/**
 * Every relation a query asks for alongside the record itself, at any
 * depth. The pack can see the relation and never the model behind it,
 * so each read travels with the path it was written under and the
 * checker resolves that path on the model's contract.
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
 * `include` takes relations and nothing else, so every key under it is
 * one. `select` takes columns as `true` and relations as an object, so
 * only the objects are relations.
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
      // `include: { comments: true }` hands back whole records.
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

/** What a write puts in another model, and the relation it goes through. */
interface NestedWrite {
  relationPath: string[];
  fields: string[];
  operation: string;
  /**
   * Set when the columns are the foreign key of the last relation in
   * the path rather than columns the call states, which only the
   * contract can supply.
   */
  relationKey?: true;
}

/** The row values a nested operation states, and the columns they fill. */
interface WrittenRows {
  /**
   * The columns the operation fills. `["*"]` when the call does not
   * write the payload out here, which says a row is written without
   * saying which columns, the same answer a top-level write with an
   * unreadable `data` gives.
   */
  fields: string[];
  /** The row maps to keep walking, for relations of their own. */
  rows: ObjectArg[];
}

type ReadWrittenRows = (payload: EffectArg | undefined) => WrittenRows;

/** `create: { name: tag }`, or a list of those: the payload is the row. */
const rowIsPayload: ReadWrittenRows = (payload) => {
  const read = objectsIn(payload);
  return { fields: fieldsOfRows(read), rows: read.rows };
};

/**
 * An operation that puts the row a level down, `connectOrCreate:
 * { where, create: { name } }`. An upsert puts one under each of two
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
 * A nested `update` states `{ where, data }` against a list relation
 * and the row itself against a single one, so the `data` key is what
 * tells the two apart.
 */
const updateRow: ReadWrittenRows = (payload) => {
  const outer = objectsIn(payload);
  const statesData = outer.rows.some((row) => "data" in row.fields);
  return statesData ? rowsUnder("data")(payload) : rowIsPayload(payload);
};

/** A row that goes away fills no column and changes all of them. */
const wholeRow: ReadWrittenRows = () => ({ fields: ["*"], rows: [] });

/** What one nested operation changes, on either side of the relation. */
interface NestedOperation {
  /** Where it states the rows it puts in the model across the relation. */
  rows?: ReadWrittenRows;
  /**
   * Whether it moves which row is joined, which sets the foreign key
   * on whichever side declares it.
   */
  movesJoin?: true;
}

/**
 * What each operation Prisma takes under a relation does, and where it
 * states the values. A delete is here because the row it takes away
 * changes every column of that row.
 *
 * An operation that moves which row is joined sets a foreign key, and
 * which column that is depends on the side the schema declares it on,
 * so the checker reads it off the contract. Recording `connect: { id }`
 * as a write of `id` instead would report a column the code selects by
 * as one the code sets, on the wrong model at that.
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
 * Every model a write reaches through a relation, at any depth. The
 * pack sees the relation field and never the model behind it, so each
 * write travels with the path it was written under and the checker
 * resolves that path on the contract, the way a nested read does.
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
 * A key of a row map whose value is an object is either a relation with
 * nested operations under it or a column whose value is a structure,
 * and only the schema tells the two apart. A column that looks like a
 * relation survives as far as the checker, which drops a path the
 * contract does not declare as a relation.
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

/** Row maps written out in a payload, one object or a list of them. */
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

/** The columns a set of row maps fills, or the whole row when unread. */
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
 * Verify an expression's TYPE resolves to a PrismaClient: i.e. its
 * symbol declaration lives in `@prisma/client` (the package's API
 * surface) or `.prisma/client` (the generated client output Prisma
 * puts at `node_modules/.prisma/client/` by default).
 *
 * Checking the type rather than the expression's own declaration
 * covers both `const db = new PrismaClient()` (decl is a
 * VariableDeclaration, type is PrismaClient) and `ctx.prisma`
 * (decl chain doesn't directly point at PrismaClient, but the
 * resulting type does).
 */
function isPrismaClientReceiver(node: Node): boolean {
  const type = (node as unknown as { getType: () => unknown }).getType();
  if (type === null || typeof type !== "object") {
    return false;
  }
  const symbol = (type as { getSymbol?: () => unknown }).getSymbol?.();
  if (symbol === null || symbol === undefined) {
    return false;
  }
  const decls =
    (symbol as { getDeclarations?: () => Node[] }).getDeclarations?.() ?? [];
  for (const decl of decls) {
    const declSourceFile = decl.getSourceFile();
    const filePath = declSourceFile.getFilePath();
    if (
      filePath.includes("/@prisma/client/") ||
      filePath.includes("/.prisma/client/")
    ) {
      return true;
    }
  }
  return false;
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
      // `include` asks for relations beside the record, and Prisma
      // still returns every column of the record itself. Prisma
      // refuses a query carrying both, so a query with an include has
      // no select and reads the whole shape. Recording the relations it
      // asks for, and nothing else, reported every column as unread.
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
  // Write: data, create, or update. Collect from all three, since an upsert
  // can pass both create and update at the same time.
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
    // A key with an operation under it reaches across a relation, and
    // no column of this model is called that. What does change here is
    // the relation's foreign key, which only the contract knows.
    if (statesNestedOperations(value)) {
      continue;
    }
    columns.push(name);
  }
  return columns;
}

/** Whether a value under a payload key is a relation's operations. */
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

/**
 * Where each raw method states its statement. The tagged form writes it
 * as a template and the unsafe form as a string, and a tagged template
 * is a call whose one argument is the template, so both put it in the
 * same position.
 */
const STATEMENT: SqlMethod = { statement: { at: 0 } };

/**
 * The raw path, as a declaration.
 *
 * A raw call bypasses the typed client, so the text of the statement is
 * what says which tables the query touches, and the ending reads it.
 * Which client the call is on is settled by where the method was
 * declared: the generated client lives under `.prisma/client` and the
 * package's own surface under `@prisma/client`, and a project reaches
 * its client through one or the other.
 */
function rawStatements(options: PrismaRecognizerOptions): SqlStatements {
  // Prisma's provider is the store and the SQL the statements are
  // written in at once, so the one option states both.
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
 * The pack. It recognizes calls and nothing else: a Prisma call is not
 * a boundary of its own, it is an effect inside a handler or a service
 * some other pack discovered, so there are no discovery patterns and no
 * terminals here.
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
    // Skip files that don't import from @prisma/client: the
    // recognizer's type-resolution check would reject them anyway.
    requiresImport: ["@prisma/client"],
    invocationRecognizers: [makeRecognizer(options)],
    // A tagged template is not an invocation, so the raw chain runs on
    // the access walk, which visits calls as well.
    accessRecognizers: [compile(raw.declared, "@suss/framework-prisma")],
    declarations: declarationsIn([raw]),
  };
}

export default prismaFramework;
