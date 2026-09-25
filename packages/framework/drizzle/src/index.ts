/**
 * Recognizes Drizzle ORM query-builder calls and raw `db.execute`
 * statements, and records each one as a storage access on the SQL table
 * it touches.
 *
 * The builder path reads ts-morph nodes directly. Each chain has one
 * anchor call, and the recognizer reads the rest of the chain by walking
 * up from it. The raw path is a `@suss/recognize` declaration. The README
 * lists the anchors, how the receiver and the table name are settled, and
 * what is left out.
 */

import { type CallExpression, Node as N, type Node } from "ts-morph";
import { z } from "zod";

import {
  arrayLiteralOf,
  objectLiteralOf,
  propertiesOf,
  propertyNameOf,
  propertyOf,
  receiverTypeMatching,
  stringValueOf,
  writtenNodeOf,
} from "@suss/adapter-typescript";
import { storageBinding } from "@suss/behavioral-ir";
import { scopeOption, storageSystemOption } from "@suss/extractor";
import {
  compile,
  constructedFrom,
  declarationsIn,
  declaredBy,
  sqlStatements,
} from "@suss/recognize";

import type { ResolutionStore } from "@suss/adapter-typescript";
import type { InvocationRecognizer, PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";
import type { SqlStatements } from "@suss/recognize";

const QUERY_API_METHODS = new Set(["findMany", "findFirst"]);

const TABLE_FACTORIES = new Set(["pgTable", "mysqlTable", "sqliteTable"]);

const DRIZZLE_PACKAGE = "drizzle-orm";

const CHAIN_WALK_LIMIT = 12;

/**
 * The options a `-f drizzle=config.json` file may set. The CLI checks
 * the file against this schema before it calls the factory.
 */
export const optionsSchema = z
  .object({
    /**
     * The storage system the calls target, `"postgresql"` when unset. It
     * has to match the `storageSystem` on provider summaries, or the
     * calls do not pair.
     */
    storageSystem: storageSystemOption.optional(),
    /** Scope for the storage binding, `"default"` when unset. */
    scope: scopeOption.optional(),
  })
  .strict();

export type DrizzleRecognizerOptions = z.infer<typeof optionsSchema>;

interface RecognizedQuery {
  kind: "read" | "write";
  operation: string;
  /** Null when the table name could not be settled. */
  table: string | null;
  /** Compared with each property read in `.where(...)` to find the selector. */
  tableExprText: string | null;
  fields: string[];
  selector: string[] | null;
  calleeText: string;
}

/**
 * Only `execute` counts. The SQLite driver's `run`, `all` and `get` also
 * take a statement, but a map's `get` in a Drizzle file would then be
 * read as a query.
 */
function rawStatements(opts: DrizzleRecognizerOptions): SqlStatements {
  const storageSystem = opts.storageSystem ?? "postgresql";
  return sqlStatements({
    system: storageSystem,
    dialect: storageSystem,
    scope: opts.scope ?? "default",
    client: declaredBy("drizzle-orm"),
  })
    .methods({ execute: { statement: { at: 0 } } })
    .interpolating({ from: constructedFrom("drizzle-orm"), named: { at: 0 } })
    .example("db.execute(sql`SELECT id, email FROM users`)");
}

function makeRecognizer(opts: DrizzleRecognizerOptions): InvocationRecognizer {
  const storageSystem = opts.storageSystem ?? "postgresql";
  const scope = opts.scope ?? "default";
  return (call, ctx) => {
    const { resolution } = ctx as { resolution?: ResolutionStore };
    const query = recognizeAnchor(call as CallExpression, resolution);
    if (query === null) {
      return null;
    }
    return [
      {
        type: "interaction",
        binding: storageBinding({
          recognition: "@suss/framework-drizzle",
          storageSystem,
          scope,
          container: query.table,
        }),
        callee: query.calleeText,
        interaction: {
          class: "storage-access",
          kind: query.kind,
          fields: query.fields,
          ...(query.selector !== null ? { selector: query.selector } : {}),
          operation: query.operation,
        },
      },
    ];
  };
}

function recognizeAnchor(
  call: CallExpression,
  resolution: ResolutionStore | undefined,
): RecognizedQuery | null {
  const callee = call.getExpression();
  if (!N.isPropertyAccessExpression(callee)) {
    return null;
  }
  const method = callee.getName();

  if (method === "from") {
    return recognizeSelect(call, callee.getExpression(), resolution);
  }
  if (method === "insert" || method === "update" || method === "delete") {
    return recognizeMutation(call, callee.getExpression(), method, resolution);
  }
  if (QUERY_API_METHODS.has(method)) {
    return recognizeQueryApi(call, callee.getExpression(), method, resolution);
  }
  return null;
}

/**
 * In `db.select({...}).from(users)` the anchor is `.from(t)`, since every
 * select chain has exactly one and it has the table.
 */
function recognizeSelect(
  fromCall: CallExpression,
  receiver: Node,
  resolution: ResolutionStore | undefined,
): RecognizedQuery | null {
  if (!N.isCallExpression(receiver)) {
    return null;
  }
  const selectCallee = receiver.getExpression();
  if (!N.isPropertyAccessExpression(selectCallee)) {
    return null;
  }
  const selectName = selectCallee.getName();
  if (selectName !== "select" && selectName !== "selectDistinct") {
    return null;
  }
  if (!isDrizzleReceiver(selectCallee.getExpression())) {
    return null;
  }

  const tableArg = fromCall.getArguments()[0];
  if (tableArg === undefined) {
    return null;
  }
  const table = resolveTableName(tableArg, resolution);
  const tableExprText = tableArg.getText();

  // A bare `select()` returns the whole row.
  const selectArg = receiver.getArguments()[0];
  const projected =
    selectArg === undefined ? [] : objectKeys(selectArg, resolution);
  const fields = projected.length > 0 ? projected : ["*"];

  const chain = collectChainCalls(fromCall);
  const selector = selectorFromWhere(chain.get("where"), tableExprText);

  return {
    kind: "read",
    operation: selectName,
    table,
    tableExprText,
    fields: fields.length > 0 ? fields : ["*"],
    selector,
    calleeText: fromCall.getExpression().getText(),
  };
}

/**
 * For `db.insert(t)`, `db.update(t)` and `db.delete(t)` the anchor is the
 * operation call, and `.values`, `.set` and `.where` come from the chain
 * above it.
 */
function recognizeMutation(
  call: CallExpression,
  receiver: Node,
  operation: "insert" | "update" | "delete",
  resolution: ResolutionStore | undefined,
): RecognizedQuery | null {
  if (!isDrizzleReceiver(receiver)) {
    return null;
  }
  const tableArg = call.getArguments()[0];
  if (tableArg === undefined) {
    return null;
  }
  const table = resolveTableName(tableArg, resolution);
  const tableExprText = tableArg.getText();
  const chain = collectChainCalls(call);

  const fields =
    operation === "insert"
      ? valuesKeys(chain.get("values"), resolution)
      : operation === "update"
        ? setKeys(chain.get("set"), resolution)
        : ["*"];
  const selector = selectorFromWhere(chain.get("where"), tableExprText);

  return {
    kind: "write",
    operation,
    table,
    tableExprText,
    fields,
    selector,
    calleeText: call.getExpression().getText(),
  };
}

/**
 * In `db.query.users.findMany({...})` Drizzle types `users` as a key of
 * the schema the database was made with, so the property resolves to
 * that schema export. Its table name then comes from the same
 * `pgTable(...)` call the builder path reads. The key is the export's
 * name, which need not be the SQL name, so it is never used in its place.
 */
function recognizeQueryApi(
  call: CallExpression,
  receiver: Node,
  operation: string,
  resolution: ResolutionStore | undefined,
): RecognizedQuery | null {
  if (!N.isPropertyAccessExpression(receiver)) {
    return null;
  }
  const queryAccess = receiver.getExpression();
  if (
    !N.isPropertyAccessExpression(queryAccess) ||
    queryAccess.getName() !== "query"
  ) {
    return null;
  }
  if (!isDrizzleReceiver(queryAccess.getExpression())) {
    return null;
  }

  const table = resolveTableName(receiver, resolution);

  // `columns` narrows the fields read and `with` adds relations, so the
  // keys of both count as fields. A call with neither reads the whole row.
  const optionsArg = call.getArguments()[0];
  const options =
    optionsArg === undefined ? null : objectLiteralOf(optionsArg, resolution);
  const fields: string[] = [];
  for (const key of ["columns", "with"]) {
    const written =
      options === null ? null : propertyOf(options, key, resolution);
    if (written !== null) {
      fields.push(...objectKeys(written, resolution));
    }
  }

  return {
    kind: "read",
    operation,
    table,
    tableExprText: null,
    fields: fields.length > 0 ? fields : ["*"],
    selector: null,
    calleeText: call.getExpression().getText(),
  };
}

// ---------------------------------------------------------------------------
// Chain and receiver helpers
// ---------------------------------------------------------------------------

/**
 * Maps each method name in the chain above the anchor to its first call.
 * The walk stops after `CHAIN_WALK_LIMIT` links.
 */
function collectChainCalls(
  anchor: CallExpression,
): Map<string, CallExpression> {
  const chain = new Map<string, CallExpression>();
  let current: Node = anchor;
  for (let i = 0; i < CHAIN_WALK_LIMIT; i++) {
    const parent = current.getParent();
    if (parent === undefined || !N.isPropertyAccessExpression(parent)) {
      break;
    }
    const grandparent = parent.getParent();
    if (grandparent === undefined || !N.isCallExpression(grandparent)) {
      break;
    }
    const name = parent.getName();
    if (!chain.has(name)) {
      chain.set(name, grandparent);
    }
    current = grandparent;
  }
  return chain;
}

/**
 * Checks the receiver's type, so `drizzle(pool)`, a wrapped `ctx.db` and
 * a transaction's `tx` all count whatever they are called. The type has
 * to be declared in a file under a `drizzle-orm` directory.
 */
function isDrizzleReceiver(node: Node): boolean {
  return receiverTypeMatching(node, { declaredIn: declaredByDrizzle }) !== null;
}

function declaredByDrizzle(filePath: string): boolean {
  return filePath.includes(`/${DRIZZLE_PACKAGE}/`);
}

/**
 * Returns null when the `pgTable(...)` call behind the expression cannot
 * be found. Falling back to the identifier's name would pair with a
 * schema table that happens to share it (#121).
 */
function resolveTableName(
  tableExpr: Node,
  resolution: ResolutionStore | undefined,
): string | null {
  const written = writtenNodeOf(tableExpr, resolution);
  if (
    written === null ||
    !N.isCallExpression(written) ||
    !isTableFactory(written.getExpression(), resolution)
  ) {
    return null;
  }
  const first = written.getArguments()[0];
  return first === undefined ? null : stringValueOf(first, resolution);
}

function isTableFactory(
  callee: Node,
  resolution: ResolutionStore | undefined,
): boolean {
  if (resolution === undefined) {
    return false;
  }
  return resolution
    .importedNamesOf(callee, [DRIZZLE_PACKAGE])
    .some((name) => TABLE_FACTORIES.has(name));
}

// ---------------------------------------------------------------------------
// Field / selector extraction
// ---------------------------------------------------------------------------

function objectKeys(
  value: Node,
  resolution: ResolutionStore | undefined,
): string[] {
  const object = objectLiteralOf(value, resolution);
  if (object === null) {
    return [];
  }
  const keys: string[] = [];
  for (const property of propertiesOf(object, resolution)) {
    const name = propertyNameOf(property);
    if (name !== null) {
      keys.push(name);
    }
  }
  return keys;
}

function valuesKeys(
  valuesCall: CallExpression | undefined,
  resolution: ResolutionStore | undefined,
): string[] {
  const arg = valuesCall?.getArguments()[0];
  if (arg === undefined) {
    return ["*"];
  }
  const rows = arrayLiteralOf(arg, resolution);
  if (rows !== null) {
    const union = new Set<string>();
    for (const element of rows.getElements()) {
      for (const key of objectKeys(element, resolution)) {
        union.add(key);
      }
    }
    return union.size > 0 ? [...union] : ["*"];
  }
  const keys = objectKeys(arg, resolution);
  return keys.length > 0 ? keys : ["*"];
}

function setKeys(
  setCall: CallExpression | undefined,
  resolution: ResolutionStore | undefined,
): string[] {
  const arg = setCall?.getArguments()[0];
  if (arg === undefined) {
    return ["*"];
  }
  const keys = objectKeys(arg, resolution);
  return keys.length > 0 ? keys : ["*"];
}

/**
 * A Drizzle where clause is an operator expression such as
 * `eq(users.id, id)`, so the selector is every property read on the
 * table expression, here `id`.
 */
function selectorFromWhere(
  whereCall: CallExpression | undefined,
  tableExprText: string | null,
): string[] | null {
  if (whereCall === undefined || tableExprText === null) {
    return null;
  }
  const arg = whereCall.getArguments()[0];
  if (arg === undefined) {
    return null;
  }
  const columns = new Set<string>();
  const visit = (node: Node): void => {
    if (
      N.isPropertyAccessExpression(node) &&
      node.getExpression().getText() === tableExprText
    ) {
      columns.add(node.getName());
    }
    node.forEachChild(visit);
  };
  visit(arg);
  return columns.size > 0 ? [...columns] : null;
}

/**
 * The pack is built by hand because the builder path is a recognizer
 * written as code, which `pack()` does not take. It discovers no units,
 * so its effects need a handler pack such as Express to attach to.
 */
export function drizzleFramework(
  options: DrizzleRecognizerOptions = {},
): PatternPack {
  const raw = rawStatements(options);
  return {
    name: "drizzle",
    protocol: "in-process",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    // A file with no `drizzle-orm` import, subpaths included, has no
    // value whose type Drizzle declares.
    requiresImport: ["drizzle-orm"],
    invocationRecognizers: [makeRecognizer(options)],
    // A statement can be written as a tagged template, which the
    // invocation walk never reaches.
    accessRecognizers: [compile(raw.declared, "@suss/framework-drizzle")],
    declarations: declarationsIn([raw]),
  };
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-drizzle",
  dependencies: [{ ecosystem: "npm", name: "drizzle-orm" }],
  reads:
    "Drizzle ORM query-builder and relational-query calls. Each one becomes a storage-access interaction on the SQL table it touches.",
};

export default drizzleFramework;
