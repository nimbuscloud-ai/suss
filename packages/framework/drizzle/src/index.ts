// @suss/framework-drizzle: recognize Drizzle ORM query-builder calls
// in TypeScript and emit `interaction(class: "storage-access")` effects
// on the transitions that contain them.
//
// Recognition is AST-based via ts-morph. Drizzle spells a query as a
// method chain, so each supported shape has one ANCHOR call the
// recognizer fires on: exactly once per chain: and the rest of the
// chain is read by walking up from the anchor:
//
//   db.select({...}).from(users).where(eq(users.id, id))   anchor: .from(t)
//   db.insert(users).values({...})                         anchor: db.insert(t)
//   db.update(users).set({...}).where(...)                 anchor: db.update(t)
//   db.delete(users).where(...)                            anchor: db.delete(t)
//   db.query.users.findMany({...})                         anchor: .findMany()
//
// The receiver (`db`, or `tx` inside a transaction callback) is
// verified by TYPE: its symbol declaration must live under
// `node_modules/drizzle-orm/`. That covers `drizzle(...)` results from
// every driver entry point (node-postgres, mysql2, better-sqlite3, …)
// without naming any of them.
//
// Table identity: the table argument is an identifier declared as
// `pgTable("users", {...})` (or mysqlTable / sqliteTable). The
// recognizer walks the identifier back to that declaration and takes
// the FIRST STRING ARGUMENT: the real SQL table name: as the
// pairing channel. This intentionally differs from the Prisma pack's
// PascalCase model channel: Drizzle's schema speaks SQL names, so its
// summaries pair against SQL-flavored contracts. The two correspond
// exactly through the schema: a Prisma model's physical table is its
// model name unless `@@map` renames it, and contract-prisma records that
// rename as `storageContract.physicalTable`, which the checker accepts as a
// pairing alias, so accesses from both ORMs land on the same schema provider
// with no name guessing. When the declaration cannot be resolved, we use the
// identifier's own name, which is what the source says rather than a guess.
//
// Out of scope for v0:
//   - `db.execute(sql\`...\`)` raw SQL (needs a raw-SQL recognizer,
//     same as Prisma's $queryRaw).
//   - `alias(users, "u")` self-join aliases.
//   - Join clauses (`.leftJoin(orders, ...)`): the joined table isn't
//     yet emitted as a second effect; deferred to keep v0 focused.

import { type CallExpression, Node as N, type Node } from "ts-morph";

import { resolveAliasedSymbol } from "@suss/adapter-typescript";
import { storageBinding } from "@suss/behavioral-ir";

import type { InvocationRecognizer, PatternPack } from "@suss/extractor";

const QUERY_API_METHODS = new Set(["findMany", "findFirst"]);

/** Schema-declaration callees whose first string argument gives the table's name. */
const TABLE_FACTORIES = new Set(["pgTable", "mysqlTable", "sqliteTable"]);

const CHAIN_WALK_LIMIT = 12;

export interface DrizzleRecognizerOptions {
  /**
   * Storage system the recognized calls target. Must match the
   * `storageSystem` on provider summaries for pairing keys to line
   * up. Defaults to `"postgres"`, the dominant Drizzle deployment.
   */
  storageSystem?: "postgres" | "mysql" | "sqlite";
  /** Scope label for the storage binding. Defaults to `"default"`. */
  scope?: string;
}

interface RecognizedQuery {
  kind: "read" | "write";
  operation: string;
  /** Null when this reader could not settle which table the query names. */
  table: string | null;
  /** Source text of the table expression, for column-ref matching. */
  tableExprText: string | null;
  fields: string[];
  selector: string[] | null;
  calleeText: string;
}

function makeRecognizer(opts: DrizzleRecognizerOptions): InvocationRecognizer {
  const storageSystem = opts.storageSystem ?? "postgres";
  const scope = opts.scope ?? "default";
  return (call) => {
    const query = recognizeAnchor(call as CallExpression);
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

function recognizeAnchor(call: CallExpression): RecognizedQuery | null {
  const callee = call.getExpression();
  if (!N.isPropertyAccessExpression(callee)) {
    return null;
  }
  const method = callee.getName();

  if (method === "from") {
    return recognizeSelect(call, callee.getExpression());
  }
  if (method === "insert" || method === "update" || method === "delete") {
    return recognizeMutation(call, callee.getExpression(), method);
  }
  if (QUERY_API_METHODS.has(method)) {
    return recognizeQueryApi(call, callee.getExpression(), method);
  }
  return null;
}

/**
 * `<db>.select({...}).from(users)` / `<db>.selectDistinct(...).from(t)`.
 * The anchor is the `.from(...)` call, because that is where the table is
 * named, and every select chain has exactly one of them.
 */
function recognizeSelect(
  fromCall: CallExpression,
  receiver: Node,
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
  const table = resolveTableName(tableArg);
  const tableExprText = tableArg.getText();

  // Projected columns: keys of the select's object argument;
  // a bare `select()` reads the whole row.
  const selectArg = receiver.getArguments()[0];
  const fields =
    selectArg !== undefined && N.isObjectLiteralExpression(selectArg)
      ? objectKeys(selectArg)
      : ["*"];

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
 * `<db>.insert(t)` / `<db>.update(t)` / `<db>.delete(t)`: the anchor
 * is the operation call itself; `.values(...)`, `.set(...)`, and
 * `.where(...)` are read from the chain above it.
 */
function recognizeMutation(
  call: CallExpression,
  receiver: Node,
  operation: "insert" | "update" | "delete",
): RecognizedQuery | null {
  if (!isDrizzleReceiver(receiver)) {
    return null;
  }
  const tableArg = call.getArguments()[0];
  if (tableArg === undefined) {
    return null;
  }
  const table = resolveTableName(tableArg);
  const tableExprText = tableArg.getText();
  const chain = collectChainCalls(call);

  const fields =
    operation === "insert"
      ? valuesKeys(chain.get("values"))
      : operation === "update"
        ? setKeys(chain.get("set"))
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
 * Relational query API: `<db>.query.<schemaExport>.findMany({...})`.
 * The table property is the schema export itself, so its declaration is the
 * same `pgTable("...")` call the builder-path tables go through.
 */
function recognizeQueryApi(
  call: CallExpression,
  receiver: Node,
  operation: string,
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

  const table = resolveTableName(receiver) ?? receiver.getName();

  // `columns: { id: true, email: true }` narrows the read set;
  // `with: { orders: true }` pulls in relations: both are field
  // knowledge. Anything else reads the whole row.
  const optionsArg = call.getArguments()[0];
  const fields: string[] = [];
  if (optionsArg !== undefined && N.isObjectLiteralExpression(optionsArg)) {
    const columns = objectProperty(optionsArg, "columns");
    if (columns !== null && N.isObjectLiteralExpression(columns)) {
      fields.push(...objectKeys(columns));
    }
    const withProp = objectProperty(optionsArg, "with");
    if (withProp !== null && N.isObjectLiteralExpression(withProp)) {
      fields.push(...objectKeys(withProp));
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
 * Walk UP from an anchor call through the fluent chain, collecting
 * `methodName → call` for each link above it. First occurrence wins;
 * the walk is bounded so a pathological chain can't loop.
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
 * The receiver must BE a Drizzle database (or transaction) by type:
 * its type symbol's declaration lives under `node_modules/drizzle-orm/`.
 * Checking the type rather than the identifier covers bare instances
 * (`const db = drizzle(pool)`), wrapped context (`ctx.db`), and
 * transaction callbacks (`db.transaction(async (tx) => tx.insert(...))`).
 */
function isDrizzleReceiver(node: Node): boolean {
  const type = node.getType();
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  if (symbol === undefined) {
    return false;
  }
  for (const decl of symbol.getDeclarations()) {
    if (decl.getSourceFile().getFilePath().includes("/drizzle-orm/")) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a table expression to its SQL table name: walk the
 * identifier (or `schema.users` property access) to its declaration
 * and read the first string argument of the `pgTable(...)` /
 * `mysqlTable(...)` / `sqliteTable(...)` initializer. Falls back to
 * the expression's trailing identifier name when the declaration cannot be
 * resolved, which is what the source says rather than something invented.
 */
/**
 * The table name a declaration states, or null when this reader could
 * not settle it. Returning the written source text instead would pair
 * against a schema table that merely spells the same way (#121).
 */
function resolveTableName(tableExpr: Node): string | null {
  const symbol = N.isPropertyAccessExpression(tableExpr)
    ? tableExpr.getNameNode().getSymbol()
    : tableExpr.getSymbol();
  if (symbol === undefined) {
    return null;
  }
  for (const decl of symbol.getDeclarations()) {
    const declared = tableNameFromDeclaration(decl);
    if (declared !== null) {
      return declared;
    }
  }
  return null;
}

function tableNameFromDeclaration(decl: Node): string | null {
  // Import specifiers point one hop further: follow to the aliased
  // symbol's declarations once.
  if (N.isImportSpecifier(decl)) {
    const symbol = decl.getNameNode().getSymbol();
    const aliased =
      symbol === undefined ? undefined : resolveAliasedSymbol(symbol);
    for (const target of aliased?.getDeclarations() ?? []) {
      const name = tableNameFromDeclaration(target);
      if (name !== null) {
        return name;
      }
    }
    return null;
  }
  if (!N.isVariableDeclaration(decl)) {
    return null;
  }
  const init = decl.getInitializer();
  if (init === undefined || !N.isCallExpression(init)) {
    return null;
  }
  const calleeText = init.getExpression().getText();
  const calleeName = calleeText.split(".").pop() ?? calleeText;
  if (!TABLE_FACTORIES.has(calleeName)) {
    return null;
  }
  const first = init.getArguments()[0];
  if (first !== undefined && N.isStringLiteral(first)) {
    return first.getLiteralValue();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field / selector extraction
// ---------------------------------------------------------------------------

function objectKeys(obj: Node): string[] {
  if (!N.isObjectLiteralExpression(obj)) {
    return [];
  }
  const keys: string[] = [];
  for (const prop of obj.getProperties()) {
    if (N.isPropertyAssignment(prop) || N.isShorthandPropertyAssignment(prop)) {
      keys.push(prop.getName());
    }
  }
  return keys;
}

function objectProperty(obj: Node, name: string): Node | null {
  if (!N.isObjectLiteralExpression(obj)) {
    return null;
  }
  for (const prop of obj.getProperties()) {
    if (N.isPropertyAssignment(prop) && prop.getName() === name) {
      return prop.getInitializer() ?? null;
    }
  }
  return null;
}

/** `.values({...})`: object keys; array of objects unions the keys. */
function valuesKeys(valuesCall: CallExpression | undefined): string[] {
  const arg = valuesCall?.getArguments()[0];
  if (arg === undefined) {
    return ["*"];
  }
  if (N.isObjectLiteralExpression(arg)) {
    const keys = objectKeys(arg);
    return keys.length > 0 ? keys : ["*"];
  }
  if (N.isArrayLiteralExpression(arg)) {
    const union = new Set<string>();
    for (const element of arg.getElements()) {
      for (const key of objectKeys(element)) {
        union.add(key);
      }
    }
    return union.size > 0 ? [...union] : ["*"];
  }
  return ["*"];
}

function setKeys(setCall: CallExpression | undefined): string[] {
  const arg = setCall?.getArguments()[0];
  if (arg === undefined) {
    return ["*"];
  }
  const keys = objectKeys(arg);
  return keys.length > 0 ? keys : ["*"];
}

/**
 * Columns a `.where(...)` filters on: property accesses on the same
 * table expression (`eq(users.id, id)` filtered by `users` → ["id"]).
 * Drizzle where-clauses are operator expressions, not object literals,
 * so this reads column references rather than keys.
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
 * Pack export. Has one invocationRecognizer; no discovery
 * patterns or terminals (Drizzle calls aren't boundaries themselves
 *: they're effects on already-discovered handlers / services).
 */
export function drizzleFramework(
  options: DrizzleRecognizerOptions = {},
): PatternPack {
  return {
    name: "drizzle",
    protocol: "in-process",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    // Gate on drizzle-orm imports (matches subpaths like
    // drizzle-orm/pg-core and driver entry points): files without
    // them can't type-check as Drizzle receivers anyway.
    requiresImport: ["drizzle-orm"],
    invocationRecognizers: [makeRecognizer(options)],
  };
}

export default drizzleFramework;
