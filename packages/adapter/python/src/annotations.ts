// annotations.ts: read a Python type annotation as a declared shape.
//
// This is contract reading, not type checking (per the language-adapters
// proposal's "Types" decision): a parameter annotation, a return
// annotation, and an annotated class body (the Pydantic shape) are all
// syntax already sitting in the parse tree, converted into the same
// `TypeShape` the IR already carries for a TypeScript type. What stays
// out is inference: nothing here propagates a value's type through
// code that never annotated it, and a shape this module doesn't
// recognize degrades to an opaque `ref` by name rather than a guess.

import { createHash } from "node:crypto";

import { field } from "./ast.js";
import { resolveName } from "./scope.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { PyNode } from "./parser.js";
import type { Scope } from "./scope.js";

/**
 * Where converted class shapes are filed so a type mentioned twice
 * (once as a parameter, once nested in another model) is written once.
 * `scopeFor` is the binder's module-wide map from a class/function
 * node to the scope its own body introduces, needed to resolve names
 * written *inside* a referenced class's body (a field's own
 * annotation) rather than only names written at the annotation's own
 * use site.
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

/**
 * Convert a `type` grammar node (a parameter's or a function's
 * annotation) into a `TypeShape`. `scope` is where the annotation is
 * written, used to tell a project-local Pydantic-shaped class from an
 * unresolved or external name.
 */
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

/**
 * A bare name's declared shape, resolved through `scope`: a builtin
 * scalar, a bare `list`/`dict`, a locally-defined class read as a
 * record, or an opaque ref by name. Exported so a decorator keyword
 * argument naming a class directly (FastAPI's `response_model=Todo`)
 * reads the same way a `Todo` written in annotation position would,
 * without discovery.ts fabricating a `type` node to satisfy this
 * module's usual entry point.
 */
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
    // Dict[KeyType, ValueType]: the IR's "dictionary" shape carries
    // only the value type, matching how `TypeShape` already represents
    // a TypeScript index signature.
    return { type: "dictionary", values: shapeOf(args[1] ?? args[0]) };
  }
  if (baseName !== null && TUPLE_SET_NAMES.has(baseName)) {
    return { type: "array", items: shapeOf(args[0]) };
  }
  // An unrecognized generic (a project's own `Page[Todo]`, say):
  // opaque by its base name rather than a guessed structure.
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

/**
 * A locally-defined class's annotated body, filed once under a key
 * that pairs its name with a hash of its own source: two classes named
 * the same in different files (or edited between reads) don't collide,
 * mirroring the TypeScript adapter's `${name}@${hash}` convention.
 */
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
  // Reserved before expanding, so a self-referential model (a `Todo`
  // whose `parent: Optional["Todo"]`, say) meets its own key and stops
  // rather than recursing forever.
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

/**
 * Annotated assignments in a class body become record fields;
 * unannotated attributes carry no declared shape and are left out, the
 * way Pydantic itself only treats annotated names as model fields.
 */
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
