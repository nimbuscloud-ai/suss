// @suss/framework-prisma — recognize Prisma client calls in TypeScript
// and emit `interaction(class: "storage-access")` effects on the
// transitions that contain them.
//
// Recognition is AST-based via ts-morph: walks the call's receiver
// chain back to its root identifier, resolves that identifier's type
// via the type checker, and verifies the type's symbol declaration is
// in `@prisma/client` (or `.prisma/client` — Prisma's generated
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
//   read:   union of `select` keys + `include` keys; falls back to
//           ["*"] (default-shape) when neither is present.
//   write:  union of `data`, `create`, `update` keys (upsert carries
//           both create and update). Falls back to ["*"] for shape-
//           less writes (rare; createMany with a dynamic body).
//   selector: keys of `where` (when present).
//
// Out of scope for v0:
//   - Nested select walking (a User select that includes Order should
//     emit a second effect for Order; deferred to keep the MVP focused).
//   - $queryRaw / $executeRaw — these bypass the typed client and
//     need a raw-SQL recognizer.
//   - findUniqueOrThrow / findFirstOrThrow (trivially addable).

import {
  type CallExpression,
  Node as N,
  type Node,
  type SourceFile,
} from "ts-morph";

import { storageRelationalBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
import type {
  EffectArg,
  InvocationRecognizer,
  PatternPack,
} from "@suss/extractor";

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
  storageSystem?: "postgres" | "mysql" | "sqlite";
  /**
   * Scope label that must match the schema reader's scope. Defaults
   * to `"default"` to align with `prismaSchemaToSummaries`'s default.
   */
  scope?: string;
}

function makeRecognizer(opts: PrismaRecognizerOptions): InvocationRecognizer {
  const storageSystem = opts.storageSystem ?? "postgres";
  const scope = opts.scope ?? "default";
  return (call, ctx) => recognizePrismaCall(call, ctx, storageSystem, scope);
}

function recognizePrismaCall(
  call: unknown,
  ctx: unknown,
  storageSystem: "postgres" | "mysql" | "sqlite",
  scope: string,
): Effect[] | null {
  const callNode = call as CallExpression;
  const recognizerCtx = ctx as {
    sourceFile: SourceFile;
    extractArgs: () => EffectArg[];
  };

  // Shape gate: callee must be `<receiver>.<delegate>.<method>` —
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
  // (`prisma` / `ctx.prisma`). Check that receiver's TYPE — its
  // symbol declaration should live in `@prisma/client` /
  // `.prisma/client`.
  //
  // Checking the receiver's TYPE rather than its identifier symbol
  // covers both bare-instance receivers (`const db = new PrismaClient()`)
  // and wrapped-context receivers (`{ prisma: new PrismaClient() }.prisma`)
  // — the receiver expression's type is PrismaClient in both shapes.
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

  return [
    {
      type: "interaction",
      binding: storageRelationalBinding({
        recognition: "@suss/framework-prisma",
        storageSystem,
        scope,
        table: tableName,
      }),
      callee: callNode.getExpression().getText(),
      interaction: {
        class: "storage-access",
        kind,
        fields,
        ...(selector !== null ? { selector } : {}),
        operation: method,
      },
    },
  ];
}

/**
 * Verify an expression's TYPE resolves to a PrismaClient — i.e. its
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
    if (select === null && include === null) {
      return ["*"];
    }
    const out = new Set<string>();
    if (select !== null) {
      for (const k of Object.keys(select.fields)) {
        out.add(k);
      }
    }
    if (include !== null) {
      for (const k of Object.keys(include.fields)) {
        out.add(k);
      }
    }
    return [...out];
  }
  // Write: data | create | update — collect from all three since
  // upsert can carry both create and update at the same time.
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
 * Pack export. Carries one invocationRecognizer; no discovery
 * patterns or terminals (Prisma calls aren't boundaries themselves
 * — they're effects on already-discovered handlers / services).
 */
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
    invocationRecognizers: [makeRecognizer(options)],
  };
}

export default prismaFramework;
