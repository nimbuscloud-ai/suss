// descent.ts: language-structural rules for the unit-body walkers.
//
// A code unit's body is walked by several passes (recognizer dispatch,
// invocation-effect capture, terminal discovery, control-flow
// lowering). Each pass runs a
// ts-morph `forEachDescendant` from the unit root and has to settle the
// same question at every nested function it reaches: descend into it, or
// treat it as a hard stop? They all ask it here, so a callback whose
// calls count as the unit's cannot have branches that do not.
//
// This is ECMAScript knowledge, not runtime or framework knowledge, so
// it lives in the adapter (see docs/theory/architecture.md, "Adapter vs pack
// ownership"). A nested `FunctionExpression` / `ArrowFunction` is
// lexical scope: a Promise executor, a `.then` callback, an
// `array.forEach` body, an IIFE. The behavior inside it (calls, config
// reads, response writes) is behavior of the enclosing unit, so the
// walker descends and recognizers fire there as if the code were inline.
// A nested `FunctionDeclaration` / `MethodDeclaration` is a named unit of
// record reached through discovery or the reachable-closure pass; the
// walker stops so its behavior isn't attributed twice.
//
// The single opt-out is a pack-declared sub-unit boundary. When a pack's
// `subUnits` hook claims a nested function (a React event handler, a
// `useEffect` body, a scheduled callback), that function gets its own
// summary and identity; the walker stops at it so its effects belong to
// the sub-unit, not the parent. Those function nodes are passed in as
// `barriers`.

import {
  type ForEachDescendantTraversalControl,
  Node,
  SyntaxKind,
  type ts,
} from "ts-morph";

import { forEachDescendantWhere } from "./rawDescent.js";
import { climbSyntax, peelSyntax } from "./unwrap.js";

/**
 * Nested function nodes a pack claimed as sub-units. The unit-body
 * walkers stop at these so the sub-unit's behavior isn't double-counted
 * on the parent.
 */
export type DescentBarriers = ReadonlySet<Node>;

export const NO_BARRIERS: DescentBarriers = new Set<Node>();

/**
 * Should a body walker treat `node` as a hard stop (skip its subtree)
 * rather than descend through it?
 *
 * `func` (the unit root) is never a stop: its own body is always
 * walked. For any other node:
 *   - `FunctionDeclaration` / `MethodDeclaration` / a constructor → stop
 *     (named units of record, summarized elsewhere).
 *   - `FunctionExpression` / `ArrowFunction` → descend, unless the node
 *     is a declared sub-unit boundary, in which case stop.
 *   - anything else → not a function boundary, never a stop.
 */
export function isDescentStop(
  node: Node,
  func: Node,
  barriers: DescentBarriers = NO_BARRIERS,
): boolean {
  if (node === func) {
    return false;
  }
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node)
  ) {
    return true;
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    return barriers.has(node);
  }
  return false;
}

type Visit = (node: Node, traversal: ForEachDescendantTraversalControl) => void;

/**
 * Visit every node a unit's body runs, the way `forEachDescendant` does
 * from the unit root. A constructor also runs its class's instance field
 * initializers before its body, so `table = process.env.TABLE` is visited
 * as part of the constructor. A field set to a function defines a method
 * and runs nothing, so it is left out.
 */
export function forEachInUnitBody(root: Node, visit: Visit): void {
  root.forEachDescendant(visit);
  for (const initializer of fieldInitializersRunBy(root)) {
    let skipped = false;
    visit(initializer, {
      stop: () => {
        skipped = true;
      },
      skip: () => {
        skipped = true;
      },
      up: () => {
        skipped = true;
      },
    });
    if (!skipped) {
      initializer.forEachDescendant(visit);
    }
  }
}

/**
 * `forEachInUnitBody` for a walk that acts on a few kinds of node. It
 * reads compiler nodes and wraps only those kinds, and `visit` returns
 * true to leave out what is under the node.
 */
export function forEachInUnitBodyOfKinds(
  root: Node,
  kinds: ReadonlySet<SyntaxKind>,
  visit: (node: Node) => boolean,
): void {
  forEachInUnitBodyWhere(root, (raw) => kinds.has(raw.kind), visit);
}

/** The same walk, visiting the nodes `accepts` picks from their compiler nodes. */
export function forEachInUnitBodyWhere(
  root: Node,
  accepts: (raw: ts.Node) => boolean,
  visit: (node: Node) => boolean,
): void {
  forEachDescendantWhere(root, accepts, visit);
  for (const initializer of fieldInitializersRunBy(root)) {
    if (accepts(initializer.compilerNode) && visit(initializer)) {
      continue;
    }
    forEachDescendantWhere(initializer, accepts, visit);
  }
}

function fieldInitializersRunBy(root: Node): Node[] {
  if (!Node.isConstructorDeclaration(root)) {
    return [];
  }
  const owner = root.getParent();
  if (!Node.isClassDeclaration(owner) && !Node.isClassExpression(owner)) {
    return [];
  }
  return owner.getProperties().flatMap((property) => {
    const initializer = property.getInitializer();
    if (initializer === undefined || property.isStatic()) {
      return [];
    }
    const written = peelSyntax(initializer);
    return Node.isArrowFunction(written) || Node.isFunctionExpression(written)
      ? []
      : [initializer];
  });
}

/**
 * Is `node` a nested function whose body runs as part of `func`'s own
 * flow: an arrow or a function expression that no pack claimed?
 *
 * This is the same rule as `isDescentStop`, asked the other way round,
 * so the pass that reads a unit's control flow and the passes that read
 * its effects agree on which nested functions belong to it. A named
 * declaration is a unit of record and never one of these.
 */
export function isInlineCallback(
  node: Node,
  func: Node,
  barriers: DescentBarriers = NO_BARRIERS,
): boolean {
  if (node === func) {
    return false;
  }
  if (!(Node.isArrowFunction(node) || Node.isFunctionExpression(node))) {
    return false;
  }
  return !barriers.has(node);
}

/**
 * Every kind of node `isDescentStop` or `isModuleScopeStop` can stop at,
 * and a decorator, which the invocation walk also stops at. A walk that
 * visits only the kinds it acts on adds these so its stops still run.
 */
export const DESCENT_STOP_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.Decorator,
]);

/** `DESCENT_STOP_KINDS` and the kinds a walk acts on, as one set. */
export function withDescentStops(
  ...kinds: SyntaxKind[]
): ReadonlySet<SyntaxKind> {
  return new Set([...DESCENT_STOP_KINDS, ...kinds]);
}

/**
 * Should a walk of the module's own initialization treat `node` as a
 * hard stop?
 *
 * The rule is stricter than `isDescentStop` because the question is
 * different. Inside a unit, a nested arrow is a callback the unit
 * itself runs, so its behavior is the unit's. At module scope, a
 * function is a value being defined rather than code being run: the
 * body of `const read = () => process.env.PORT` executes when somebody
 * calls `read`, not when the module loads. So does a class member.
 * Both are summarized where they run instead. A function the module
 * invokes on the spot is the exception, since the body of
 * `(async () => { await sync(); })()` does run while the module loads.
 */
export function isModuleScopeStop(node: Node): boolean {
  if (isImmediatelyInvoked(node)) {
    return false;
  }
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isClassDeclaration(node) ||
    Node.isClassExpression(node)
  );
}

/**
 * Whether this call runs a function written as its own callee. There is
 * no name behind such a call for a reader to follow, and whoever owns
 * the call already owns everything the body does.
 */
export function invokesFunctionInPlace(call: Node): boolean {
  return (
    Node.isCallExpression(call) &&
    isImmediatelyInvoked(peelSyntax(call.getExpression()))
  );
}

/** Whether this function is the callee of the call it is written inside. */
function isImmediatelyInvoked(node: Node): boolean {
  if (!Node.isArrowFunction(node) && !Node.isFunctionExpression(node)) {
    return false;
  }
  const climbed = climbSyntax(node);
  const consumer = climbed.getParent();
  return (
    consumer !== undefined &&
    Node.isCallExpression(consumer) &&
    consumer.getExpression() === climbed
  );
}

/**
 * Does reaching `node` from `func` cross (or land on) a nested
 * function-expression / arrow scope?
 *
 * Terminal discovery uses this to keep return-valued terminals (a
 * `return`, a returned object shape, a JSX render) scoped to their own
 * function: a `return` inside a `.then` callback yields the callback's
 * value, not the enclosing unit's. Terminals that write through a
 * parent-owned channel (a `res.json(...)` on the unit's own parameter)
 * stay observable regardless of nesting and are matched anyway.
 */
export function crossesNestedFunctionScope(node: Node, func: Node): boolean {
  let current: Node | undefined = node;
  while (current !== undefined && current !== func) {
    if (startsItsOwnScope(current)) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}

/**
 * Does this node return for itself rather than for whatever encloses
 * it? An accessor and a constructor do, the same way a callback does,
 * so a getter inside a returned object returns for the getter.
 */
export function startsItsOwnScope(node: Node): boolean {
  return OWN_SCOPE_KINDS.has(node.getKind());
}

/** The kinds `startsItsOwnScope` is true of, for a walk over compiler nodes. */
export const OWN_SCOPE_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor,
]);
