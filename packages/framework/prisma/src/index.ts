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
// relation back the way a query does.
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
import { readSqlAccess, sqlFromParts } from "@suss/sql";

import type { Effect } from "@suss/behavioral-ir";
import type {
  AccessRecognizer,
  EffectArg,
  InvocationRecognizer,
  PatternPack,
} from "@suss/extractor";

/** The client methods that take a statement written as SQL. */
const RAW_METHODS = new Set([
  "$queryRaw",
  "$executeRaw",
  "$queryRawUnsafe",
  "$executeRawUnsafe",
]);

const PRISMA_READ_METHODS = new Set([
  "findUnique",
  "findFirst",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

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
   * pairing keys won't match. Defaults to `"postgres"` since that's
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
  const out = new Set<string>();
  for (const propName of ["data", "create", "update"]) {
    const prop = readObjectArg(optionsArg.fields[propName]);
    if (prop === null) {
      continue;
    }
    for (const k of Object.keys(prop.fields)) {
      out.add(k);
    }
  }
  if (out.size === 0) {
    return ["*"];
  }
  return [...out];
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
 * Pack export. Has one invocationRecognizer; no discovery
 * patterns or terminals (Prisma calls aren't boundaries themselves
 *: they're effects on already-discovered handlers / services).
 */
/**
 * `prisma.$queryRaw\`...\`` states its query as SQL and bypasses the
 * typed client, so the text is what says which tables it touches. The
 * tagged template is where the query is, and the access hook is what
 * gets handed one.
 */
function makeRawRecognizer(opts: PrismaRecognizerOptions): AccessRecognizer {
  const storageSystem = opts.storageSystem ?? "postgresql";
  const scope = opts.scope ?? "default";
  return ((node: unknown) => {
    const statement = rawStatementAt(node as Node);
    if (statement === null) {
      return null;
    }
    const accesses = readSqlAccess(statement.sql, { dialect: storageSystem });
    if (accesses.length === 0) {
      return null;
    }
    return accesses.map((access) => ({
      type: "interaction" as const,
      binding: storageBinding({
        recognition: "@suss/framework-prisma",
        storageSystem,
        scope,
        container: access.table,
      }),
      callee: statement.callee,
      interaction: {
        class: "storage-access" as const,
        kind: access.kind,
        fields: access.fields,
        ...(access.selector.length > 0 ? { selector: access.selector } : {}),
        operation: statement.method,
      },
    }));
  }) as AccessRecognizer;
}

/**
 * The SQL a raw call states, whichever way it was written. The tagged
 * form takes the query as a template and the unsafe form takes it as a
 * string, and both go through a client the receiver has to be.
 */
function rawStatementAt(
  node: Node,
): { sql: string; method: string; callee: string } | null {
  const tag = N.isTaggedTemplateExpression(node)
    ? node.getTag()
    : N.isCallExpression(node)
      ? node.getExpression()
      : null;
  if (tag === null || !N.isPropertyAccessExpression(tag)) {
    return null;
  }
  const method = tag.getName();
  if (!RAW_METHODS.has(method)) {
    return null;
  }
  if (!isPrismaClientReceiver(tag.getExpression())) {
    return null;
  }
  const sql = N.isTaggedTemplateExpression(node)
    ? templateSql(node.getTemplate())
    : N.isCallExpression(node)
      ? literalSql(node.getArguments()[0])
      : null;
  return sql === null ? null : { sql, method, callee: tag.getText() };
}

function templateSql(template: Node): string | null {
  if (N.isNoSubstitutionTemplateLiteral(template)) {
    return template.getLiteralValue();
  }
  if (!N.isTemplateExpression(template)) {
    return null;
  }
  return sqlFromParts([
    template.getHead().getLiteralText(),
    ...template
      .getTemplateSpans()
      .map((span) => span.getLiteral().getLiteralText()),
  ]);
}

function literalSql(argument: Node | undefined): string | null {
  if (argument === undefined) {
    return null;
  }
  if (
    N.isStringLiteral(argument) ||
    N.isNoSubstitutionTemplateLiteral(argument)
  ) {
    return argument.getLiteralValue();
  }
  return N.isTemplateExpression(argument) ? templateSql(argument) : null;
}

export function prismaFramework(
  options: PrismaRecognizerOptions = {},
): PatternPack {
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
    accessRecognizers: [makeRawRecognizer(options)],
  };
}

export default prismaFramework;
