/**
 * Recognize Prisma Client model-delegate calls and emit `storage-access`
 * effects.
 *
 * The anchor is the generated type: `prisma.article.findMany(...)`
 * resolves `.article`'s type to `ArticleDelegate`, which is what lets
 * this fire through a project's own wrapper module. A query that
 * reaches through a relation gets its own effect with
 * `interaction.relationPath` set, rather than a guess at which model the
 * relation points to. See the README for the field-by-field detail.
 */

import { Node as N, SyntaxKind } from "ts-morph";

import { storageBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
import type { InvocationRecognizer, PatternPack } from "@suss/extractor";
import type {
  ArrayLiteralExpression,
  CallExpression,
  ObjectLiteralExpression,
  StringLiteral,
  Node as TsNode,
} from "ts-morph";

const RECOGNITION = "@suss/framework-prisma-mined";

/**
 * Where the generated client's declarations live, whichever the
 * project's generator `output` is set to. The default writes to
 * `.prisma/client` and `@prisma/client` re-exports it; a custom
 * `output` path is not covered.
 */
const CLIENT_MODULES = [".prisma/client", "@prisma/client"];

const DELEGATE_SUFFIX = "Delegate";

/** How many relation levels a read is walked through. */
const MAX_RELATION_DEPTH = 4;

/** Prisma's own filter combinators, which wrap further where-clauses rather than naming a field. */
const WHERE_LOGICAL_KEYS = new Set(["AND", "OR", "NOT"]);

/** Select/include keys that describe an aggregate rather than a relation's own fields. */
const AGGREGATE_SELECTION_KEYS = new Set(["_count"]);

/**
 * Relation-write operators that mint or mutate a row on the far side of
 * the relation, and how each reads its fields. `connect`, `disconnect`,
 * and `set` are handled separately: they name the relation and never a
 * field of the far row. `createMany`, `upsert`, `update`, `updateMany`,
 * `delete`, and `deleteMany` inside a relation are not covered here;
 * see the README for why.
 */
const RELATION_WRITE_OPERATORS: Record<
  string,
  (value: TsNode, resolve: Resolve) => string[]
> = {
  create: (value, resolve) => objectOrArrayKeys(value, resolve),
  connectOrCreate: (value, resolve) => connectOrCreateFields(value, resolve),
};

/** Relation-write operators that only ever name the relation, never a field of the far row. */
const RELATION_LINK_OPERATORS = new Set(["connect", "disconnect", "set"]);

/** `where` shapes Prisma requires to be unique, so a single filter key says which secondary index this reads rather than what it filters on. */
const UNIQUE_WHERE_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "delete",
  "upsert",
]);

type ArgShape = "select" | "data" | "upsert" | "whole" | "count" | "groupBy";

interface Operation {
  kind: "read" | "write";
  argShape: ArgShape;
}

/** Every operation a Prisma model delegate declares, and how each reads its options argument. */
const OPERATIONS: Record<string, Operation> = {
  findUnique: { kind: "read", argShape: "select" },
  findUniqueOrThrow: { kind: "read", argShape: "select" },
  findFirst: { kind: "read", argShape: "select" },
  findFirstOrThrow: { kind: "read", argShape: "select" },
  findMany: { kind: "read", argShape: "select" },
  count: { kind: "read", argShape: "count" },
  aggregate: { kind: "read", argShape: "count" },
  groupBy: { kind: "read", argShape: "groupBy" },
  create: { kind: "write", argShape: "data" },
  createMany: { kind: "write", argShape: "data" },
  update: { kind: "write", argShape: "data" },
  updateMany: { kind: "write", argShape: "data" },
  upsert: { kind: "write", argShape: "upsert" },
  delete: { kind: "write", argShape: "whole" },
  deleteMany: { kind: "write", argShape: "whole" },
};

const FIELDS_EXTRACTORS: Record<
  ArgShape,
  (options: ObjectLiteralExpression | null, resolve: Resolve) => string[]
> = {
  select: readFieldsFrom,
  data: writeFieldsFrom,
  upsert: upsertFieldsFrom,
  whole: () => ["*"],
  count: () => [],
  groupBy: groupByFieldsFrom,
};

export interface PrismaRecognizerOptions {
  /**
   * The database Prisma targets. Not visible from a client call: the
   * schema's `datasource` block is the source of truth, and this pack
   * never reads the schema. Defaults to `"postgresql"`, Prisma's most
   * common deployment.
   */
  storageSystem?: string;
  /** Scope label for the storage binding. Defaults to `"default"`. */
  scope?: string;
}

type Resolve = (value: TsNode) => TsNode | null;

interface RecognizerContext {
  resolveWrittenValue?: Resolve;
}

function makeRecognizer(opts: PrismaRecognizerOptions): InvocationRecognizer {
  const storageSystem = opts.storageSystem ?? "postgresql";
  const scope = opts.scope ?? "default";

  return ((call: unknown, ctx: unknown) => {
    const callNode = call as CallExpression;
    const resolve =
      (ctx as RecognizerContext).resolveWrittenValue ?? (() => null);

    const opAccess = callNode.getExpression();
    if (!N.isPropertyAccessExpression(opAccess)) {
      return null;
    }
    const operationName = opAccess.getName();
    const operation = OPERATIONS[operationName];
    if (operation === undefined) {
      return null;
    }

    const modelAccess = opAccess.getExpression();
    if (!N.isPropertyAccessExpression(modelAccess)) {
      return null;
    }
    const model = prismaModelOf(modelAccess);
    if (model === null) {
      return null;
    }

    const optionsArg = callNode.getArguments()[0];
    const options =
      optionsArg !== undefined ? objectLiteralOf(optionsArg, resolve) : null;

    const binding = storageBinding({
      recognition: RECOGNITION,
      storageSystem,
      scope,
      container: model,
      accessPath: accessPathFor(operationName, options, resolve),
    });

    const selector = selectorFromWhere(options, resolve);
    const fields = FIELDS_EXTRACTORS[operation.argShape](options, resolve);

    const primary: Effect = {
      type: "interaction",
      binding,
      callee: opAccess.getText(),
      interaction: {
        class: "storage-access",
        kind: operation.kind,
        fields,
        operation: operationName,
        ...(selector !== null ? { selector } : {}),
      },
    };

    const relationEffects =
      operation.kind === "read"
        ? relationReadEffects(storageSystem, scope, model, options, resolve, [])
        : relationWriteEffects(
            storageSystem,
            scope,
            model,
            options,
            resolve,
            [],
          );

    return [primary, ...relationEffects];
  }) as InvocationRecognizer;
}

/**
 * The model a `prisma.<model>` access reaches, read off the generated
 * delegate type rather than the property's own spelling. Works through
 * any indirection ts-morph can type: the property's static type is the
 * generator's `ArticleDelegate` regardless of how the receiver got there.
 */
function prismaModelOf(modelAccess: TsNode): string | null {
  const symbol = modelAccess.getType().getSymbol();
  if (symbol === undefined) {
    return null;
  }
  const name = symbol.getName();
  if (!name.endsWith(DELEGATE_SUFFIX)) {
    return null;
  }
  const declarations = symbol.getDeclarations();
  const fromClient = declarations.some((decl) =>
    CLIENT_MODULES.some((module) =>
      decl.getSourceFile().getFilePath().includes(`/node_modules/${module}/`),
    ),
  );
  return fromClient ? name.slice(0, -DELEGATE_SUFFIX.length) : null;
}

/**
 * The single non-`id` filter key of a unique `where`, Prisma's own
 * secondary-index shape (`findUnique({ where: { slug } })` reads the
 * `slug` unique index). Assumes the primary key field is named `id`;
 * a schema that spells the primary key field differently is not distinguishable here.
 */
function accessPathFor(
  operationName: string,
  options: ObjectLiteralExpression | null,
  resolve: Resolve,
): string | null {
  if (!UNIQUE_WHERE_OPERATIONS.has(operationName) || options === null) {
    return null;
  }
  const whereObj = objectLiteralOf(namedProperty(options, "where"), resolve);
  if (whereObj === null) {
    return null;
  }
  const keys = objectKeys(whereObj, resolve);
  return keys.length === 1 && keys[0] !== "id" ? (keys[0] ?? null) : null;
}

/** Field names a `where` filters on, recursing through `AND`/`OR`/`NOT` since those wrap further where-clauses instead of naming a field. */
function selectorFromWhere(
  options: ObjectLiteralExpression | null,
  resolve: Resolve,
): string[] | null {
  if (options === null) {
    return null;
  }
  const whereNode = namedProperty(options, "where");
  if (whereNode === null) {
    return null;
  }
  const fields = collectWhereFields(whereNode, resolve);
  return fields.length > 0 ? fields : null;
}

function collectWhereFields(node: TsNode, resolve: Resolve): string[] {
  const obj = objectLiteralOf(node, resolve);
  if (obj === null) {
    return [];
  }
  const fields = new Set<string>();
  for (const prop of obj.getProperties()) {
    const name = propertyName(prop);
    if (name === null) {
      continue;
    }
    if (WHERE_LOGICAL_KEYS.has(name)) {
      const value = propertyValue(prop);
      if (value === null) {
        continue;
      }
      for (const inner of whereNodesFrom(value, resolve)) {
        for (const field of collectWhereFields(inner, resolve)) {
          fields.add(field);
        }
      }
      continue;
    }
    fields.add(name);
  }
  return [...fields];
}

/** `AND`/`OR`/`NOT` each take one where-clause or a list of them. */
function whereNodesFrom(value: TsNode, resolve: Resolve): TsNode[] {
  const arr = arrayLiteralOf(value, resolve);
  return arr !== null ? arr.getElements() : [value];
}

/** Top-level keys of `select`, or `["*", ...include keys]` for `include`, since include adds relations on top of every scalar rather than narrowing them. */
function readFieldsFrom(
  options: ObjectLiteralExpression | null,
  resolve: Resolve,
): string[] {
  if (options === null) {
    return ["*"];
  }
  const selectObj = objectLiteralOf(namedProperty(options, "select"), resolve);
  if (selectObj !== null) {
    const keys = objectKeys(selectObj, resolve);
    return keys.length > 0 ? keys : ["*"];
  }
  const includeObj = objectLiteralOf(
    namedProperty(options, "include"),
    resolve,
  );
  if (includeObj !== null) {
    const keys = objectKeys(includeObj, resolve);
    return keys.length > 0 ? ["*", ...keys] : ["*"];
  }
  return ["*"];
}

/** Top-level keys of `data`, a single row or an array of them for `createMany`. */
function writeFieldsFrom(
  options: ObjectLiteralExpression | null,
  resolve: Resolve,
): string[] {
  if (options === null) {
    return ["*"];
  }
  const dataNode = namedProperty(options, "data");
  return dataNode !== null ? objectOrArrayKeys(dataNode, resolve) : ["*"];
}

/** `upsert` has no `data`; the fields it can write are the union of `create` and `update`. */
function upsertFieldsFrom(
  options: ObjectLiteralExpression | null,
  resolve: Resolve,
): string[] {
  if (options === null) {
    return ["*"];
  }
  const keys = new Set<string>();
  for (const key of ["create", "update"]) {
    const node = namedProperty(options, key);
    const obj = node !== null ? objectLiteralOf(node, resolve) : null;
    if (obj !== null) {
      for (const field of objectKeys(obj, resolve)) {
        keys.add(field);
      }
    }
  }
  return keys.size > 0 ? [...keys] : ["*"];
}

/** `groupBy`'s `by` says which fields it groups on; that is what it reads. */
function groupByFieldsFrom(
  options: ObjectLiteralExpression | null,
  resolve: Resolve,
): string[] {
  if (options === null) {
    return ["*"];
  }
  const byNode = namedProperty(options, "by");
  const arr = byNode !== null ? arrayLiteralOf(byNode, resolve) : null;
  if (arr === null) {
    return ["*"];
  }
  const names = arr
    .getElements()
    .filter((el): el is StringLiteral => N.isStringLiteral(el))
    .map((el) => el.getLiteralValue());
  return names.length > 0 ? names : ["*"];
}

/**
 * One effect per relation named in `select`/`include`, walked
 * recursively: a relation selected with its own nested `select` gets a
 * further effect for each relation named there. `_count` is an
 * aggregate, not a relation's own fields, so it is skipped.
 */
function relationReadEffects(
  storageSystem: string,
  scope: string,
  model: string,
  options: ObjectLiteralExpression | null,
  resolve: Resolve,
  path: string[],
): Effect[] {
  if (options === null || path.length >= MAX_RELATION_DEPTH) {
    return [];
  }
  // Only `include` is unambiguously all relations; see the README for
  // why a bare `true` under `select` is not treated as one.
  const includeObj = objectLiteralOf(
    namedProperty(options, "include"),
    resolve,
  );
  const selectObj =
    includeObj === null
      ? objectLiteralOf(namedProperty(options, "select"), resolve)
      : null;
  const source = includeObj ?? selectObj;
  if (source === null) {
    return [];
  }

  const effects: Effect[] = [];
  for (const prop of source.getProperties()) {
    const name = propertyName(prop);
    const value = propertyValue(prop);
    if (name === null || value === null || AGGREGATE_SELECTION_KEYS.has(name)) {
      continue;
    }
    const nestedObj = objectLiteralOf(value, resolve);
    if (nestedObj === null && includeObj === null) {
      continue;
    }
    const nestedPath = [...path, name];
    const nestedFields =
      nestedObj === null ? ["*"] : readFieldsFrom(nestedObj, resolve);
    effects.push(
      relationEffect(
        storageSystem,
        scope,
        model,
        "read",
        nestedPath,
        nestedFields,
      ),
    );
    if (nestedObj !== null) {
      effects.push(
        ...relationReadEffects(
          storageSystem,
          scope,
          model,
          nestedObj,
          resolve,
          nestedPath,
        ),
      );
    }
  }
  return effects;
}

/**
 * One effect per relation field in `data` whose value has a
 * recognized nested-write operator (`create`, `connectOrCreate`, or a
 * link operator). Walked one level: a `create` payload that itself
 * nests another relation is not followed further.
 */
function relationWriteEffects(
  storageSystem: string,
  scope: string,
  model: string,
  options: ObjectLiteralExpression | null,
  resolve: Resolve,
  path: string[],
): Effect[] {
  if (options === null) {
    return [];
  }
  const dataObj = objectLiteralOf(namedProperty(options, "data"), resolve);
  if (dataObj === null) {
    return [];
  }

  const effects: Effect[] = [];
  for (const prop of dataObj.getProperties()) {
    const name = propertyName(prop);
    const value = propertyValue(prop);
    const valueObj = value === null ? null : objectLiteralOf(value, resolve);
    if (name === null || valueObj === null) {
      continue;
    }
    const nestedPath = [...path, name];
    for (const opProp of valueObj.getProperties()) {
      const opName = propertyName(opProp);
      const opValue = propertyValue(opProp);
      if (opName === null || opValue === null) {
        continue;
      }
      if (RELATION_LINK_OPERATORS.has(opName)) {
        effects.push(
          relationEffect(
            storageSystem,
            scope,
            model,
            "write",
            nestedPath,
            [],
            true,
          ),
        );
        continue;
      }
      const handler = RELATION_WRITE_OPERATORS[opName];
      if (handler === undefined) {
        continue;
      }
      effects.push(
        relationEffect(
          storageSystem,
          scope,
          model,
          "write",
          nestedPath,
          handler(opValue, resolve),
        ),
      );
    }
  }
  return effects;
}

function relationEffect(
  storageSystem: string,
  scope: string,
  model: string,
  kind: "read" | "write",
  relationPath: string[],
  fields: string[],
  relationKey?: true,
): Effect {
  return {
    type: "interaction",
    binding: storageBinding({
      recognition: RECOGNITION,
      storageSystem,
      scope,
      container: model,
      accessPath: null,
    }),
    callee: relationPath.join("."),
    interaction: {
      class: "storage-access",
      kind,
      fields,
      relationPath,
      ...(relationKey === true ? { relationKey: true } : {}),
    },
  };
}

/** `connectOrCreate`'s payload, single or a list, each a `{ create, where }` pair: the fields written are the `create` side's. */
function connectOrCreateFields(node: TsNode, resolve: Resolve): string[] {
  const elements = elementsOf(node, resolve);
  const keys = new Set<string>();
  for (const element of elements) {
    const elObj = objectLiteralOf(element, resolve);
    const createObj =
      elObj !== null
        ? objectLiteralOf(namedProperty(elObj, "create"), resolve)
        : null;
    if (createObj !== null) {
      for (const key of objectKeys(createObj, resolve)) {
        keys.add(key);
      }
    }
  }
  return keys.size > 0 ? [...keys] : ["*"];
}

/** An object literal's own keys, or the union of keys across an array of them. */
function objectOrArrayKeys(node: TsNode, resolve: Resolve): string[] {
  const keys = new Set<string>();
  for (const element of elementsOf(node, resolve)) {
    const obj = objectLiteralOf(element, resolve);
    if (obj !== null) {
      for (const key of objectKeys(obj, resolve)) {
        keys.add(key);
      }
    }
  }
  return keys.size > 0 ? [...keys] : ["*"];
}

/**
 * A written array's elements, one per `.map(fn)` call reading as the
 * shape `fn` returns, since every element built by one callback shares
 * it. Falls back to treating the node itself as the sole element, the
 * shape a single relation payload (not a list) is written as.
 */
function elementsOf(node: TsNode, resolve: Resolve): TsNode[] {
  const arr = arrayLiteralOf(node, resolve);
  if (arr !== null) {
    return arr.getElements();
  }
  const mapped = mapCallbackReturn(node);
  return mapped !== null ? [mapped] : [node];
}

function mapCallbackReturn(node: TsNode): TsNode | null {
  if (!N.isCallExpression(node)) {
    return null;
  }
  const callee = node.getExpression();
  if (!N.isPropertyAccessExpression(callee) || callee.getName() !== "map") {
    return null;
  }
  const callback = node.getArguments()[0];
  if (
    callback === undefined ||
    !(N.isArrowFunction(callback) || N.isFunctionExpression(callback))
  ) {
    return null;
  }
  const body = callback.getBody();
  if (N.isExpression(body)) {
    return body;
  }
  if (!N.isBlock(body)) {
    return null;
  }
  const statements = body.getStatements();
  const only = statements[0];
  return statements.length === 1 &&
    only !== undefined &&
    N.isReturnStatement(only)
    ? (only.getExpression() ?? null)
    : null;
}

function objectKeys(obj: ObjectLiteralExpression, resolve: Resolve): string[] {
  const keys: string[] = [];
  for (const prop of obj.getProperties()) {
    const name = propertyName(prop);
    if (name !== null) {
      keys.push(name);
      continue;
    }
    if (N.isSpreadAssignment(prop)) {
      keys.push(...keysFromSpread(prop.getExpression(), resolve));
    }
  }
  return keys;
}

/**
 * `...(condition ? { a } : {})` and `...(condition && { a })` conditionally
 * include a field, the idiom a partial update builds its `data` with. Either
 * branch could run, so a key from either counts as a field the call can
 * write.
 */
function keysFromSpread(expr: TsNode, resolve: Resolve): string[] {
  const inner = N.isParenthesizedExpression(expr) ? expr.getExpression() : expr;
  if (N.isConditionalExpression(inner)) {
    return [
      ...keysFromBranch(inner.getWhenTrue(), resolve),
      ...keysFromBranch(inner.getWhenFalse(), resolve),
    ];
  }
  if (
    N.isBinaryExpression(inner) &&
    inner.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken
  ) {
    return keysFromBranch(inner.getRight(), resolve);
  }
  return keysFromBranch(inner, resolve);
}

function keysFromBranch(node: TsNode, resolve: Resolve): string[] {
  const obj = objectLiteralOf(node, resolve);
  return obj !== null ? objectKeys(obj, resolve) : [];
}

function propertyName(prop: TsNode): string | null {
  if (N.isPropertyAssignment(prop) || N.isShorthandPropertyAssignment(prop)) {
    return prop.getName();
  }
  return null;
}

function propertyValue(prop: TsNode): TsNode | null {
  if (N.isPropertyAssignment(prop)) {
    return prop.getInitializer() ?? null;
  }
  if (N.isShorthandPropertyAssignment(prop)) {
    return prop.getNameNode();
  }
  return null;
}

function namedProperty(
  obj: ObjectLiteralExpression,
  name: string,
): TsNode | null {
  for (const prop of obj.getProperties()) {
    if (propertyName(prop) === name) {
      return propertyValue(prop);
    }
  }
  return null;
}

/** An object literal, resolving one hop through a bound identifier when the node itself is not one. */
function objectLiteralOf(
  node: TsNode | null,
  resolve: Resolve,
): ObjectLiteralExpression | null {
  if (node === null) {
    return null;
  }
  if (N.isParenthesizedExpression(node)) {
    return objectLiteralOf(node.getExpression(), resolve);
  }
  if (N.isObjectLiteralExpression(node)) {
    return node;
  }
  const resolved = resolve(node);
  return resolved !== null && resolved !== node
    ? objectLiteralOf(resolved, resolve)
    : null;
}

/** An array literal, resolving one hop through a bound identifier when the node itself is not one. */
function arrayLiteralOf(
  node: TsNode | null,
  resolve: Resolve,
): ArrayLiteralExpression | null {
  if (node === null) {
    return null;
  }
  if (N.isArrayLiteralExpression(node)) {
    return node;
  }
  const resolved = resolve(node);
  return resolved !== null && resolved !== node
    ? arrayLiteralOf(resolved, resolve)
    : null;
}

/**
 * Pack export. One recognizer, gated on a file reaching the generated
 * client (directly or through a project's own wrapper module).
 */
export function prismaMinedFramework(
  options: PrismaRecognizerOptions = {},
): PatternPack {
  return {
    name: "prisma-mined",
    protocol: "in-process",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    requiresImport: CLIENT_MODULES,
    invocationRecognizers: [makeRecognizer(options)],
  };
}

export default prismaMinedFramework;
