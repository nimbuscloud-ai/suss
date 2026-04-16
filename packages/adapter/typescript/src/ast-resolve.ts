// ast-resolve.ts — Walk the AST to resolve terminal expressions to their
// defining value.
//
// The type checker is our fallback for identifiers, property access, and
// calls, but it widens literal types at reference sites (`declare const x:
// "ok"` becomes `string` when read). When the user wrote an actual literal
// somewhere, we'd rather preserve it. This module walks back from a
// reference to the declaration and re-enters `extractShape` on the value
// expression — which lets literal narrowness survive across variable
// bindings, property lookups, and single-return functions.
//
// Returning `null` means "I can't say anything useful" — callers fall
// through to `shapeFromNodeType` for the type-checker view.

import { Node, SyntaxKind } from "ts-morph";

import type { TypeShape } from "@suss/behavioral-ir";
import type {
  CallExpression,
  ElementAccessExpression,
  Identifier,
  PropertyAccessExpression,
} from "ts-morph";

/**
 * Maximum declaration hops to follow before giving up. Stops pathological
 * chains (`const a = b; const b = c; const c = ...`) from eating stack.
 */
const MAX_HOPS = 8;

/**
 * Shared seen-set scoped to one top-level `extractShape` call. Carries node
 * positions (source path + start offset) to detect cycles like `const a = a`.
 */
interface ResolveContext {
  seen: Set<string>;
  hops: number;
}

export type ShapeExtractor = (node: Node) => TypeShape | null;

/**
 * Attempt to resolve `node` to a `TypeShape` by walking AST declarations.
 * Handles identifiers, property access chains, and calls. Returns `null`
 * when the AST alone can't decide — callers should fall back to the type
 * checker.
 */
export function resolveNodeFromAst(
  node: Node,
  extractShape: ShapeExtractor,
): TypeShape | null {
  return resolve(node, extractShape, { seen: new Set(), hops: 0 });
}

function resolve(
  node: Node,
  extractShape: ShapeExtractor,
  ctx: ResolveContext,
): TypeShape | null {
  if (ctx.hops >= MAX_HOPS) {
    return null;
  }
  const key = nodeKey(node);
  if (ctx.seen.has(key)) {
    return null;
  }

  const next: ResolveContext = {
    seen: new Set(ctx.seen).add(key),
    hops: ctx.hops + 1,
  };

  if (Node.isIdentifier(node)) {
    return resolveIdentifier(node, extractShape, next);
  }

  if (Node.isPropertyAccessExpression(node)) {
    return resolvePropertyAccess(node, extractShape, next);
  }

  if (Node.isElementAccessExpression(node)) {
    return resolveElementAccess(node, extractShape, next);
  }

  if (Node.isCallExpression(node)) {
    return resolveCall(node, extractShape, next);
  }

  return null;
}

function resolveIdentifier(
  id: Identifier,
  extractShape: ShapeExtractor,
  ctx: ResolveContext,
): TypeShape | null {
  // Walk to the defining declarations. For imports, ts-morph follows across
  // source files for free — that's what makes this pass worthwhile in a
  // monorepo.
  const definitions = safeGetDefinitions(id);
  for (const def of definitions) {
    const shape = shapeFromDeclaration(def, extractShape, ctx);
    if (shape !== null) {
      return shape;
    }
  }
  return null;
}

function resolvePropertyAccess(
  pae: PropertyAccessExpression,
  extractShape: ShapeExtractor,
  ctx: ResolveContext,
): TypeShape | null {
  const objShape = resolve(pae.getExpression(), extractShape, ctx);
  if (objShape === null) {
    return null;
  }
  const name = pae.getName();
  return readProperty(objShape, name);
}

function resolveElementAccess(
  eae: ElementAccessExpression,
  extractShape: ShapeExtractor,
  ctx: ResolveContext,
): TypeShape | null {
  // Only constant string / numeric indices are resolvable at the AST level.
  const arg = eae.getArgumentExpression();
  if (!arg) {
    return null;
  }
  let key: string | null = null;
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) {
    key = arg.getLiteralValue();
  } else if (Node.isNumericLiteral(arg)) {
    key = String(arg.getLiteralValue());
  }
  if (key === null) {
    return null;
  }
  const objShape = resolve(eae.getExpression(), extractShape, ctx);
  if (objShape === null) {
    return null;
  }
  return readProperty(objShape, key);
}

function resolveCall(
  call: CallExpression,
  extractShape: ShapeExtractor,
  ctx: ResolveContext,
): TypeShape | null {
  // Only resolve calls whose callee is a local identifier we can walk to a
  // function declaration with a single return statement. Anything more
  // elaborate (overloads, method calls, conditional returns) is safer to
  // leave for the type checker.
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) {
    return null;
  }
  const defs = safeGetDefinitions(callee);
  for (const def of defs) {
    const body = functionBodyOf(def);
    if (!body) {
      continue;
    }
    const returned = singleReturnExpression(body);
    if (!returned) {
      continue;
    }
    const shape = enterShape(returned, extractShape, ctx);
    if (shape !== null) {
      return shape;
    }
  }
  return null;
}

function shapeFromDeclaration(
  decl: Node,
  extractShape: ShapeExtractor,
  ctx: ResolveContext,
): TypeShape | null {
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (!init) {
      return null;
    }
    // Only walk into initializers that are syntactically "informative" —
    // i.e. something the AST can tell us that the type checker would widen.
    // For calls, awaits, and `new` expressions, the declaration-site type
    // is often *wider* than the use-site type (e.g. `const user = await
    // db.find()` returns `T | null`, but past a null guard the use site is
    // just `T`). Walking back to the declaration would drop that narrowing;
    // defer to the use-site type checker instead.
    if (!isInformativeInitializer(init)) {
      return null;
    }
    return enterShape(init, extractShape, ctx);
  }

  if (Node.isBindingElement(decl)) {
    // `const { id } = user` — treat the name as a property of the binding
    // source. Walk: find the enclosing VariableDeclaration's initializer and
    // read the property.
    const varDecl = decl.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    if (!varDecl) {
      return null;
    }
    const init = varDecl.getInitializer();
    if (!init) {
      return null;
    }
    if (!isInformativeInitializer(init)) {
      return null;
    }
    const name = decl.getName();
    const parentShape = enterShape(init, extractShape, ctx);
    if (!parentShape) {
      return null;
    }
    return readProperty(parentShape, name);
  }

  if (Node.isShorthandPropertyAssignment(decl)) {
    // Shouldn't normally be a *definition* site, but be robust.
    const init = decl.getNameNode();
    return enterShape(init, extractShape, ctx);
  }

  // Function / parameter / class declarations don't have a single-value
  // shape we can extract. Caller falls back to the type checker.
  return null;
}

function enterShape(
  node: Node,
  extractShape: ShapeExtractor,
  ctx: ResolveContext,
): TypeShape | null {
  const key = nodeKey(node);
  if (ctx.seen.has(key)) {
    return null;
  }
  ctx.seen.add(key);
  ctx.hops += 1;
  if (ctx.hops > MAX_HOPS) {
    return null;
  }
  return extractShape(node);
}

function readProperty(shape: TypeShape, name: string): TypeShape | null {
  if (shape.type === "record") {
    const prop = shape.properties[name];
    if (prop !== undefined) {
      return prop;
    }
    // Spreads might contribute — we can't read through them at the AST
    // level. Fall through.
    return null;
  }
  if (shape.type === "dictionary") {
    return shape.values;
  }
  if (shape.type === "union") {
    // Read the property from every variant; collapse the results. A variant
    // that lacks the property contributes nothing (we're optimistic — this
    // is the "reachable shapes" read, not a safety check).
    const picked: TypeShape[] = [];
    for (const variant of shape.variants) {
      const sub = readProperty(variant, name);
      if (sub !== null) {
        picked.push(sub);
      }
    }
    if (picked.length === 0) {
      return null;
    }
    if (picked.length === 1) {
      return picked[0];
    }
    return { type: "union", variants: dedupe(picked) };
  }
  return null;
}

function dedupe(shapes: TypeShape[]): TypeShape[] {
  const out: TypeShape[] = [];
  const seen = new Set<string>();
  for (const s of shapes) {
    const k = JSON.stringify(s);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

/**
 * Peek at an initializer to decide whether walking back to it gives us
 * information the type checker at the use site would have lost. "Informative"
 * here means the initializer syntactically carries narrower info than its
 * declared type would imply — literals, object/array literals, ternaries,
 * other identifiers we might be able to chase through, etc. Everything else
 * (calls, awaits, `new`) tends to bind wider types that use-site flow
 * narrowing would have tightened; we defer those to the type checker.
 */
function isInformativeInitializer(node: Node): boolean {
  const unwrapped = unwrapInitializer(node);

  if (
    Node.isStringLiteral(unwrapped) ||
    Node.isNoSubstitutionTemplateLiteral(unwrapped) ||
    Node.isNumericLiteral(unwrapped) ||
    Node.isBigIntLiteral(unwrapped) ||
    Node.isObjectLiteralExpression(unwrapped) ||
    Node.isArrayLiteralExpression(unwrapped) ||
    Node.isTemplateExpression(unwrapped) ||
    Node.isConditionalExpression(unwrapped) ||
    Node.isIdentifier(unwrapped) ||
    Node.isPropertyAccessExpression(unwrapped) ||
    Node.isElementAccessExpression(unwrapped)
  ) {
    return true;
  }

  if (Node.isPrefixUnaryExpression(unwrapped)) {
    return isInformativeInitializer(unwrapped.getOperand());
  }

  const kind = unwrapped.getKind();
  return (
    kind === SyntaxKind.TrueKeyword ||
    kind === SyntaxKind.FalseKeyword ||
    kind === SyntaxKind.NullKeyword
  );
}

/**
 * Peel the same shape-preserving wrappers `extractShape` peels, so we judge
 * informativeness on the underlying expression. Must mirror `shapes.ts`'s
 * `unwrap` — but we don't unwrap `await`, since await's declared type is the
 * call's return type (still widened at declaration), and we want to bail out
 * there.
 */
function unwrapInitializer(node: Node): Node {
  let current = node;
  for (let i = 0; i < 16; i++) {
    if (Node.isAsExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isTypeAssertion(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isParenthesizedExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isNonNullExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isSatisfiesExpression(current)) {
      current = current.getExpression();
      continue;
    }
    break;
  }
  return current;
}

/**
 * Resolve a callable expression (identifier or property access) to its
 * single-expression body and parameter names. Returns null when the
 * callee can't be resolved to a simple function.
 *
 * Used by both shape extraction (resolveCall) and predicate inlining.
 */
export function resolveCallableBody(
  callee: Node,
): { bodyExpr: Node; paramNames: string[] } | null {
  if (!Node.isIdentifier(callee)) {
    return null;
  }
  const defs = safeGetDefinitions(callee);
  for (const def of defs) {
    const body = functionBodyOf(def);
    if (!body) {
      continue;
    }
    const bodyExpr = singleReturnExpression(body);
    if (!bodyExpr) {
      continue;
    }
    const paramNames = extractParamNames(def);
    return { bodyExpr, paramNames };
  }
  return null;
}

function extractParamNames(decl: Node): string[] {
  const getParams = (
    fn:
      | import("ts-morph").FunctionDeclaration
      | import("ts-morph").ArrowFunction
      | import("ts-morph").FunctionExpression
      | import("ts-morph").MethodDeclaration,
  ) => fn.getParameters().map((p) => p.getName());

  if (
    Node.isFunctionDeclaration(decl) ||
    Node.isFunctionExpression(decl) ||
    Node.isArrowFunction(decl) ||
    Node.isMethodDeclaration(decl)
  ) {
    return getParams(decl);
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (
      init &&
      (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
    ) {
      return getParams(init);
    }
  }
  return [];
}

function safeGetDefinitions(id: Node): Node[] {
  if (!Node.isIdentifier(id)) {
    return [];
  }
  try {
    return id.getDefinitionNodes();
  } catch {
    return [];
  }
}

function functionBodyOf(decl: Node): Node | null {
  if (
    Node.isFunctionDeclaration(decl) ||
    Node.isFunctionExpression(decl) ||
    Node.isArrowFunction(decl) ||
    Node.isMethodDeclaration(decl)
  ) {
    const body = decl.getBody();
    return body ?? null;
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (
      init &&
      (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
    ) {
      return init.getBody();
    }
  }
  return null;
}

function singleReturnExpression(body: Node): Node | null {
  if (!Node.isBlock(body)) {
    // Arrow function with expression body: the body itself is the return.
    return body;
  }
  const statements = body.getStatements();
  if (statements.length !== 1) {
    return null;
  }
  const stmt = statements[0];
  if (!Node.isReturnStatement(stmt)) {
    return null;
  }
  return stmt.getExpression() ?? null;
}

function nodeKey(node: Node): string {
  return `${node.getSourceFile().getFilePath()}:${node.getStart()}:${node.getKind()}`;
}
