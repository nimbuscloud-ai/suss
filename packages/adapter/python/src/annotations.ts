/**
 * Turns a Python annotation into an IR type shape.
 *
 * Nothing here infers anything. A value nobody annotated has no shape at all,
 * and an annotation this module does not recognize comes back as a `ref` by
 * name, which says only what the source called it.
 */

import { createHash } from "node:crypto";

import { field } from "./ast.js";
import { resolveName } from "./scope.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { PyNode } from "./parser.js";
import type { Scope } from "./scope.js";

/**
 * `definitions` stores each converted class shape once, however many annotations
 * mention it. `scopeFor` is here so a name written inside a referenced class's
 * body resolves too, not only one written at the annotation's use site.
 */
export interface AnnotationContext {
  scopeFor: Map<number, Scope>;
  definitions: Map<string, TypeShape | null>;
}

export function createAnnotationContext(
  scopeFor: Map<number, Scope>,
): AnnotationContext {
  return { scopeFor, definitions: new Map() };
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
  return { type: "ref", name };
}

function genericTypeArgs(node: PyNode): PyNode[] {
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
  const args = genericTypeArgs(node);
  const shapeOf = (arg: PyNode | undefined): TypeShape =>
    arg !== undefined
      ? annotationToShape(arg, scope, ctx)
      : { type: "unknown" };

  const baseName = base?.type === "identifier" ? base.text : null;
  if (baseName === "Optional") {
    return { type: "union", variants: [shapeOf(args[0]), { type: "null" }] };
  }
  if (baseName === "Union") {
    return { type: "union", variants: args.map((arg) => shapeOf(arg)) };
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
  return { type: "ref", name: baseName ?? node.text };
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
  const classScope = ctx.scopeFor.get(classNode.id);
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
