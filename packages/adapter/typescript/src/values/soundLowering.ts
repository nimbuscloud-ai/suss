/**
 * The TypeScript lowering a sound evaluator runs over: the plain one
 * with three things made strict, since a sound run must never give a
 * value some run of the program would not have.
 *
 * - A call inlines only when it calls, by its plain name, the function
 *   declared under that name, and an async one only when awaited.
 * - A name is read only when the function binds it once and nothing
 *   writes it again, and only where that binding is in scope, so a
 *   shadowed name or a `++` never leaves a stale value.
 * - A `try` with a `catch` lowers to both, since either may end the
 *   function, and a statement that only declares something does nothing.
 */

import { Node, SyntaxKind, VariableDeclarationKind } from "ts-morph";

import { peelSyntax } from "../walk/unwrap.js";
import { typescriptLowering } from "./lowering.js";
import { typescriptSoundRows } from "./rows.js";

import type { Lowering, Statement } from "@suss/values";
import type { ResolutionStore } from "../facts/store.js";

const NO_OP: Statement<Node> = { kind: "block", body: [] };

/** Statements that declare something or move control within a loop or switch, and give the function no value. */
const DECLARING_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.ModuleDeclaration,
  SyntaxKind.ImportDeclaration,
  SyntaxKind.EmptyStatement,
  SyntaxKind.DebuggerStatement,
  SyntaxKind.BreakStatement,
  SyntaxKind.ContinueStatement,
]);

export function typescriptSoundLowering(
  resolution: ResolutionStore | undefined,
): Lowering<Node> {
  const base = typescriptLowering(
    resolution === undefined
      ? { rows: typescriptSoundRows }
      : { resolution, rows: typescriptSoundRows },
  );
  const writtenOnceByRoot = new WeakMap<Node, ReadonlySet<string>>();
  return {
    ...base,
    statement: (node) => soundStatementOf(node) ?? base.statement(node),
    callable: (node) => {
      const target = base.callable(node);
      return target !== null && callsExactly(node, target) ? target : null;
    },
    writtenOnce: (root, name) => {
      let names = writtenOnceByRoot.get(root);
      if (names === undefined) {
        names = namesWrittenOnce(root);
        writtenOnceByRoot.set(root, names);
      }
      return names.has(name);
    },
  };
}

function soundStatementOf(node: Node): Statement<Node> | null {
  if (DECLARING_KINDS.has(node.getKind())) {
    return NO_OP;
  }
  if (!Node.isTryStatement(node)) {
    return null;
  }
  const handler = node.getCatchClause();
  const cleanup = node.getFinallyBlock();
  // A `return` in a `finally` replaces whatever the body returned.
  if (
    cleanup !== undefined &&
    (handler !== undefined || returnsFrom(cleanup))
  ) {
    return { kind: "opaque" };
  }
  if (handler === undefined) {
    return null;
  }
  return {
    kind: "branch",
    condition: null,
    arms: [
      node.getTryBlock().getStatements(),
      handler.getBlock().getStatements(),
    ],
  };
}

/** Whether a block returns from the function it is written in. */
function returnsFrom(block: Node): boolean {
  let found = false;
  block.forEachDescendant((node, traversal) => {
    if (Node.isFunctionLikeDeclaration(node)) {
      traversal.skip();
      return;
    }
    if (Node.isReturnStatement(node)) {
      found = true;
      traversal.stop();
    }
  });
  return found;
}

/**
 * Whether the call runs `target` and nothing else: it calls the name
 * `target` is declared under, and gets back what `target` returns.
 */
function callsExactly(node: Node, target: Node): boolean {
  const outer = peelSyntax(node);
  const awaited = Node.isAwaitExpression(outer);
  const call = Node.isAwaitExpression(outer)
    ? peelSyntax(outer.getExpression())
    : outer;
  if (!Node.isCallExpression(call)) {
    return false;
  }
  const callee = peelSyntax(call.getExpression());
  if (!Node.isIdentifier(callee) || !declaredUnder(target, callee.getText())) {
    return false;
  }
  if (Node.isGeneratorable(target) && target.isGenerator()) {
    return false;
  }
  // A `this` parameter states the receiver's type and takes no argument,
  // so the engine would hand it the first one.
  if (
    Node.isFunctionLikeDeclaration(target) &&
    target.getParameters().some((parameter) => parameter.getName() === "this")
  ) {
    return false;
  }
  return awaited || !(Node.isAsyncable(target) && target.isAsync());
}

/** Whether `target` is the function a name declares: `function name`, or a `const name` bound to an arrow or a function expression. */
function declaredUnder(target: Node, name: string): boolean {
  if (Node.isFunctionDeclaration(target)) {
    return target.getName() === name;
  }
  if (!Node.isArrowFunction(target) && !Node.isFunctionExpression(target)) {
    return false;
  }
  const declaration = target.getParent();
  return (
    Node.isVariableDeclaration(declaration) &&
    declaration.getName() === name &&
    declaration.getVariableStatement()?.getDeclarationKind() ===
      VariableDeclarationKind.Const
  );
}

/**
 * The names `root` binds exactly once and never writes again, read only
 * inside the scope that binding is in. Every identifier that binds or
 * writes counts, a nested function's included, so a shadowing
 * declaration or a callback's parameter makes the name untrusted.
 */
function namesWrittenOnce(root: Node): ReadonlySet<string> {
  const writes = new Map<string, Node[]>();
  const uses = new Map<string, Node[]>();
  root.forEachDescendant((node) => {
    if (!Node.isIdentifier(node)) {
      return;
    }
    const name = node.getText();
    listUnder(uses, name, node);
    if (writesName(node)) {
      listUnder(writes, name, node);
    }
  });
  const once = new Set<string>();
  for (const [name, written] of writes) {
    const only = written[0];
    if (written.length !== 1 || only === undefined) {
      continue;
    }
    const scope = trustedScopeOf(only, root);
    if (
      scope !== null &&
      (uses.get(name) ?? []).every((use) => isWithin(use, scope))
    ) {
      once.add(name);
    }
  }
  return once;
}

function listUnder(map: Map<string, Node[]>, name: string, node: Node): void {
  const listed = map.get(name);
  if (listed === undefined) {
    map.set(name, [node]);
    return;
  }
  listed.push(node);
}

function isWithin(node: Node, scope: Node): boolean {
  let current: Node | undefined = node;
  while (current !== undefined) {
    if (current === scope) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}

/** Whether this identifier binds a name or writes to one. */
function writesName(id: Node): boolean {
  const parent = id.getParent();
  if (parent === undefined) {
    return false;
  }
  if (
    (Node.isVariableDeclaration(parent) ||
      Node.isBindingElement(parent) ||
      Node.isParameterDeclaration(parent) ||
      Node.isFunctionDeclaration(parent) ||
      Node.isFunctionExpression(parent) ||
      Node.isClassDeclaration(parent) ||
      Node.isClassExpression(parent)) &&
    parent.getNameNode() === id
  ) {
    return true;
  }
  if (
    Node.isImportSpecifier(parent) ||
    Node.isImportClause(parent) ||
    Node.isNamespaceImport(parent) ||
    Node.isImportEqualsDeclaration(parent)
  ) {
    return true;
  }
  return isAssignedTo(id);
}

/** Whether an identifier is the target of an assignment, a `++` or `--`, or a `for ... of` head, through any destructuring pattern around it. */
function isAssignedTo(id: Node): boolean {
  let current: Node = id;
  for (;;) {
    const parent = current.getParent();
    if (parent === undefined) {
      return false;
    }
    if (isAssignment(parent)) {
      return Node.isBinaryExpression(parent) && parent.getLeft() === current;
    }
    if (
      (Node.isPrefixUnaryExpression(parent) ||
        Node.isPostfixUnaryExpression(parent)) &&
      isIncrement(parent.getOperatorToken())
    ) {
      return true;
    }
    if (
      (Node.isForOfStatement(parent) || Node.isForInStatement(parent)) &&
      parent.getInitializer() === current
    ) {
      return true;
    }
    if (!isPatternLayer(parent, current)) {
      return false;
    }
    current = parent;
  }
}

function isAssignment(node: Node): boolean {
  if (!Node.isBinaryExpression(node)) {
    return false;
  }
  const kind = node.getOperatorToken().getKind();
  return (
    kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment
  );
}

function isIncrement(operator: SyntaxKind): boolean {
  return (
    operator === SyntaxKind.PlusPlusToken ||
    operator === SyntaxKind.MinusMinusToken
  );
}

/** Whether `parent` passes an assignment target through to `child`, as a pattern or a wrapper does. */
function isPatternLayer(parent: Node, child: Node): boolean {
  if (
    Node.isParenthesizedExpression(parent) ||
    Node.isNonNullExpression(parent) ||
    Node.isAsExpression(parent) ||
    Node.isSatisfiesExpression(parent) ||
    Node.isTypeAssertion(parent) ||
    Node.isArrayLiteralExpression(parent) ||
    Node.isObjectLiteralExpression(parent) ||
    Node.isShorthandPropertyAssignment(parent) ||
    Node.isSpreadElement(parent) ||
    Node.isSpreadAssignment(parent)
  ) {
    return true;
  }
  return Node.isPropertyAssignment(parent) && parent.getInitializer() === child;
}

/**
 * Where a binding the engine can follow is in scope, or null for one it
 * cannot. A `let` or `const` statement of `root`'s own is in scope in
 * its block, and a `var` or a parameter of `root` everywhere in `root`.
 * A parameter with a default is left out, since a call that passes
 * `undefined` gets the default.
 */
function trustedScopeOf(id: Node, root: Node): Node | null {
  const parent = id.getParent();
  if (Node.isParameterDeclaration(parent)) {
    return parent.getParent() === root &&
      !parent.isRestParameter() &&
      !parent.hasInitializer()
      ? root
      : null;
  }
  if (!Node.isVariableDeclaration(parent)) {
    return null;
  }
  const statement = parent.getVariableStatement();
  if (statement === undefined || enclosingFunctionOf(statement) !== root) {
    return null;
  }
  if (statement.getDeclarationKind() === VariableDeclarationKind.Var) {
    return root;
  }
  return statement.getParent() ?? null;
}

function enclosingFunctionOf(node: Node): Node | undefined {
  let current = node.getParent();
  while (
    current !== undefined &&
    !Node.isSourceFile(current) &&
    !Node.isFunctionLikeDeclaration(current)
  ) {
    current = current.getParent();
  }
  return current;
}
