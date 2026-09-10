/**
 * Turns a Python annotation into an IR type shape.
 *
 * Nothing here infers anything. A value nobody annotated has no shape at all,
 * and an annotation this module does not recognize comes back as a `ref` by
 * name, which says only what the source called it.
 */

import { createHash } from "node:crypto";

import { field, fields } from "./ast.js";
import { resolveName } from "./scope.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { ImportedDefinitionLookup } from "./importedDefinitions.js";
import type { PyNode } from "./parser.js";
import type { Scope } from "./scope.js";

/**
 * `definitions` stores each converted class shape once, however many annotations
 * mention it. `scopeMaps` is here so a name written inside a referenced class's
 * body resolves too, not only one written at the annotation's use site; a class
 * read from another file brings that file's scopes along. `importedDefinition`
 * is absent when a caller reads one file on its own, and an imported name is
 * then a ref by name and nothing more.
 */
export interface AnnotationContext {
  scopeMaps: Map<number, Scope>[];
  definitions: Map<string, TypeShape | null>;
  importedDefinition: ImportedDefinitionLookup | null;
  /** The alias values being expanded, so `A = B` and `B = A` end rather than recurse. */
  expanding: Set<number>;
}

export function createAnnotationContext(
  scopeFor: Map<number, Scope>,
  importedDefinition: ImportedDefinitionLookup | null = null,
): AnnotationContext {
  return {
    scopeMaps: [scopeFor],
    definitions: new Map(),
    importedDefinition,
    expanding: new Set(),
  };
}

function scopeOfNode(ctx: AnnotationContext, node: PyNode): Scope | undefined {
  for (const scopeFor of ctx.scopeMaps) {
    const scope = scopeFor.get(node.id);
    if (scope !== undefined) {
      return scope;
    }
  }
  return undefined;
}

/** The value assigned to a name, in this file or an imported one. */
export interface AliasValue {
  node: PyNode;
  /** Where the value is written, which is where the identifiers inside it resolve. */
  scope: Scope;
}

/**
 * The value behind an annotation written as a bare name that is neither a
 * builtin nor a class: `db: SessionDep` with `SessionDep = Annotated[...]`
 * assigned in this file or imported from another. Null for a class, for a
 * name outside the project, and for one the binder could not resolve.
 */
export function aliasValueOf(
  name: string,
  scope: Scope,
  ctx: AnnotationContext,
): AliasValue | null {
  const binding = resolveName(scope, name);
  if (binding?.kind === "assignment") {
    return binding.value === null ? null : { node: binding.value, scope };
  }
  if (binding?.kind !== "import" && binding?.kind !== "importFrom") {
    return null;
  }
  const imported = ctx.importedDefinition?.(scope, name) ?? null;
  if (imported === null || imported.node.type === "class_definition") {
    return null;
  }
  return { node: imported.node, scope: imported.moduleScope };
}

export function collectedDefinitions(
  ctx: AnnotationContext,
): Record<string, TypeShape> | null {
  const out: Record<string, TypeShape> = {};
  let any = false;
  for (const [key, shape] of ctx.definitions) {
    if (shape !== null) {
      out[key] = shape;
      any = true;
    }
  }
  return any ? out : null;
}

const BUILTIN_SCALARS: Record<string, TypeShape> = {
  int: { type: "integer" },
  float: { type: "number" },
  str: { type: "text" },
  bytes: { type: "text" },
  bool: { type: "boolean" },
  Any: { type: "unknown" },
  object: { type: "unknown" },
};

const LIST_NAMES = new Set(["list", "List", "Sequence", "Iterable"]);
const DICT_NAMES = new Set(["dict", "Dict", "Mapping"]);
const TUPLE_SET_NAMES = new Set([
  "tuple",
  "Tuple",
  "set",
  "Set",
  "frozenset",
  "FrozenSet",
]);

/** `scope` is where the annotation is written, which is how we tell a project-local class from an external name. */
export function annotationToShape(
  typeNode: PyNode,
  scope: Scope,
  ctx: AnnotationContext,
): TypeShape {
  const inner = typeNode.namedChild(0);
  if (inner === null) {
    return { type: "unknown" };
  }
  return shapeFromExpression(inner, scope, ctx);
}

type ExpressionShaper = (
  node: PyNode,
  scope: Scope,
  ctx: AnnotationContext,
) => TypeShape;

const EXPRESSION_SHAPERS: Record<string, ExpressionShaper> = {
  identifier: (node, scope, ctx) => shapeFromName(node.text, scope, ctx),
  none: () => ({ type: "null" }),
  generic_type: shapeFromGenericType,
  subscript: shapeFromSubscript,
  binary_operator: shapeFromBinaryOperator,
};

function shapeFromExpression(
  node: PyNode,
  scope: Scope,
  ctx: AnnotationContext,
): TypeShape {
  const handler = EXPRESSION_SHAPERS[node.type];
  return handler !== undefined
    ? handler(node, scope, ctx)
    : { type: "unknown" };
}

/** Exported so a decorator keyword that gives a class name reads the same way as that name written in annotation position. */
export function shapeFromName(
  name: string,
  scope: Scope,
  ctx: AnnotationContext,
): TypeShape {
  const scalar = BUILTIN_SCALARS[name];
  if (scalar !== undefined) {
    return scalar;
  }
  if (LIST_NAMES.has(name)) {
    return { type: "array", items: { type: "unknown" } };
  }
  if (DICT_NAMES.has(name)) {
    return { type: "dictionary", values: { type: "unknown" } };
  }
  const binding = resolveName(scope, name);
  if (binding?.kind === "classDef") {
    return recordShapeRef(name, binding.node, ctx);
  }
  if (binding?.kind === "import" || binding?.kind === "importFrom") {
    const imported = ctx.importedDefinition?.(scope, name) ?? null;
    if (imported?.node.type === "class_definition") {
      if (!ctx.scopeMaps.includes(imported.scopeFor)) {
        ctx.scopeMaps.push(imported.scopeFor);
      }
      return recordShapeRef(name, imported.node, ctx);
    }
  }
  const alias = aliasValueOf(name, scope, ctx);
  if (alias !== null) {
    return shapeFromAliasValue(name, alias, ctx);
  }
  return { type: "ref", name };
}

/** `SessionDep = Annotated[Session, ...]` gives a parameter the shape `Session` has; any other value is read as an expression. */
function shapeFromAliasValue(
  name: string,
  alias: AliasValue,
  ctx: AnnotationContext,
): TypeShape {
  if (ctx.expanding.has(alias.node.id)) {
    return { type: "ref", name };
  }
  ctx.expanding.add(alias.node.id);
  try {
    return shapeFromExpression(alias.node, alias.scope, ctx);
  } finally {
    ctx.expanding.delete(alias.node.id);
  }
}

/** `list[Item]` written as a value rather than in annotation position, where the grammar calls it a subscript. */
function shapeFromSubscript(
  node: PyNode,
  scope: Scope,
  ctx: AnnotationContext,
): TypeShape {
  const base = field(node, "value");
  const args = fields(node, "subscript");
  const baseName = base?.type === "identifier" ? base.text : null;
  if (baseName === "Annotated") {
    const first = args[0];
    return first === undefined
      ? { type: "unknown" }
      : shapeFromExpression(first, scope, ctx);
  }
  return shapeFromGeneric(
    baseName,
    node.text,
    args.map((arg) => shapeFromExpression(arg, scope, ctx)),
  );
}

/** The `type` nodes inside the brackets of `Outer[A, B]`. */
export function genericTypeArgs(node: PyNode): PyNode[] {
  const typeParameter = node.namedChildren.find(
    (child) => child !== null && child.type === "type_parameter",
  );
  return (
    typeParameter?.namedChildren.filter(
      (child): child is PyNode => child !== null && child.type === "type",
    ) ?? []
  );
}

function shapeFromGenericType(
  node: PyNode,
  scope: Scope,
  ctx: AnnotationContext,
): TypeShape {
  const base = node.namedChild(0);
  const baseName = base?.type === "identifier" ? base.text : null;
  return shapeFromGeneric(
    baseName,
    node.text,
    genericTypeArgs(node).map((arg) => annotationToShape(arg, scope, ctx)),
  );
}

/** `Outer[A, B]` with its arguments already read, however the brackets were parsed. */
function shapeFromGeneric(
  baseName: string | null,
  text: string,
  args: TypeShape[],
): TypeShape {
  const shapeOf = (arg: TypeShape | undefined): TypeShape =>
    arg ?? { type: "unknown" };

  if (baseName === "Optional") {
    return { type: "union", variants: [shapeOf(args[0]), { type: "null" }] };
  }
  if (baseName === "Union") {
    return { type: "union", variants: args };
  }
  if (baseName !== null && LIST_NAMES.has(baseName)) {
    return { type: "array", items: shapeOf(args[0]) };
  }
  if (baseName !== null && DICT_NAMES.has(baseName)) {
    // The key type is dropped here, because the IR's dictionary shape only
    // records the value type: `dict[str, int]` and `dict[int, int]` come out
    // the same.
    return { type: "dictionary", values: shapeOf(args[1] ?? args[0]) };
  }
  if (baseName !== null && TUPLE_SET_NAMES.has(baseName)) {
    return { type: "array", items: shapeOf(args[0]) };
  }
  return { type: "ref", name: baseName ?? text };
}

/** PEP 604 `X | Y` written directly in an annotation, e.g. `int | None`. */
function shapeFromBinaryOperator(
  node: PyNode,
  scope: Scope,
  ctx: AnnotationContext,
): TypeShape {
  const operator = field(node, "operator");
  const left = field(node, "left");
  const right = field(node, "right");
  if (operator?.text !== "|" || left === null || right === null) {
    return { type: "unknown" };
  }
  return {
    type: "union",
    variants: [
      shapeFromExpression(left, scope, ctx),
      shapeFromExpression(right, scope, ctx),
    ],
  };
}

/** Keyed `${name}@${hash}`, following the TypeScript adapter, so two classes with the same name do not collide. */
function recordShapeRef(
  name: string,
  classNode: PyNode,
  ctx: AnnotationContext,
): TypeShape {
  const key = `${name}@${shortHash(classNode.text)}`;
  const ref: TypeShape = { type: "ref", name, def: key };
  if (ctx.definitions.has(key)) {
    return ref;
  }
  // The key is reserved before expanding the body, so a model that refers to
  // itself finds its own key already there and stops instead of recursing
  // forever.
  ctx.definitions.set(key, null);
  const bodyNode = field(classNode, "body");
  const classScope = scopeOfNode(ctx, classNode);
  ctx.definitions.set(
    key,
    bodyNode !== null && classScope !== undefined
      ? recordShapeOf(bodyNode, classScope, ctx)
      : { type: "record", properties: {} },
  );
  return ref;
}

/** Only annotated assignments become fields, which is also all Pydantic counts as model fields. */
export function recordShapeOf(
  bodyNode: PyNode,
  classScope: Scope,
  ctx: AnnotationContext,
): TypeShape {
  const properties: Record<string, TypeShape> = {};
  for (const stmt of bodyNode.namedChildren) {
    if (stmt === null || stmt.type !== "expression_statement") {
      continue;
    }
    const assignment = stmt.namedChildren.find(
      (child) => child !== null && child.type === "assignment",
    );
    if (assignment === undefined || assignment === null) {
      continue;
    }
    const left = field(assignment, "left");
    const typeNode = field(assignment, "type");
    if (left === null || left.type !== "identifier" || typeNode === null) {
      continue;
    }
    properties[left.text] = annotationToShape(typeNode, classScope, ctx);
  }
  return { type: "record", properties };
}

function shortHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}
