/**
 * Walks over the compiler's syntax tree that wrap only the nodes a pass
 * acts on.
 *
 * ts-morph wraps every node a `forEachDescendant` reaches and keeps the
 * wrapper for the rest of the run, so a pass that acts on a few kinds of
 * node pays for a wrapper on every identifier, token and annotation under
 * its root. These walks read the compiler nodes and wrap a node only when
 * its kind is one the pass asked for. A walk for code leaves out type
 * syntax, since the program never runs it: nothing under a type
 * annotation, a type alias or an interface is a call, a write or a value.
 */

import {
  type KindToNodeMappings,
  type Node,
  type SourceFile,
  ts,
} from "ts-morph";

/**
 * A file's own statements of one kind, the list `getImportDeclarations`
 * and its siblings give, with only those statements wrapped.
 */
export function statementsOfKind<Kind extends ts.SyntaxKind>(
  file: SourceFile,
  kind: Kind,
): Array<KindToNodeMappings[Kind]> {
  const found: Array<KindToNodeMappings[Kind]> = [];
  for (const raw of file.compilerNode.statements) {
    if (raw.kind === kind) {
      found.push(wrapperOf(file, raw) as KindToNodeMappings[Kind]);
    }
  }
  return found;
}

/** Which subtrees a walk leaves out, decided from the compiler node. */
export type SkipsSubtree = (raw: ts.Node) => boolean;

/**
 * Calls `visit` for each descendant of `root` whose kind is in `kinds`,
 * in the order `forEachDescendant` reaches them, and goes on below it
 * unless `visit` returns true. By default it leaves out what
 * `runsNothing` says, which suits a walk for calls, writes and values.
 */
export function forEachDescendantOfKinds(
  root: Node,
  kinds: ReadonlySet<ts.SyntaxKind>,
  visit: (node: Node) => boolean | undefined,
  skips: SkipsSubtree = runsNothing,
): void {
  forEachDescendantWhere(root, (raw) => kinds.has(raw.kind), visit, skips);
}

/** The same walk, visiting the descendants `accepts` picks from their compiler nodes. */
export function forEachDescendantWhere(
  root: Node,
  accepts: (raw: ts.Node) => boolean,
  visit: (node: Node) => boolean | undefined,
  skips: SkipsSubtree = runsNothing,
): void {
  const walk = (raw: ts.Node): undefined => {
    if (skips(raw)) {
      return undefined;
    }

    if (accepts(raw) && visit(wrapperOf(root, raw)) === true) {
      return undefined;
    }

    ts.forEachChild(raw, walk);
    return undefined;
  };
  ts.forEachChild(root.compilerNode, walk);
}

/**
 * Type syntax and `declare` statements, neither of which runs. A walk
 * that collects declarations rather than code skips only
 * `isTypeOnlySyntax`, since a declaration file's functions are all
 * declared with `declare`.
 */
export function runsNothing(raw: ts.Node): boolean {
  return isTypeOnlySyntax(raw) || isAmbient(raw);
}

/** For a walk that reads type annotations too, such as a parameter's. */
export function skipsNothing(): boolean {
  return false;
}

/**
 * Whether a node and everything under it is type syntax. A class's
 * `extends` clause is an expression, as in `extends mixin(() => ...)`,
 * so it is walked like one.
 */
export function isTypeOnlySyntax(raw: ts.Node): boolean {
  return (
    (raw.kind >= ts.SyntaxKind.FirstTypeNode &&
      raw.kind <= ts.SyntaxKind.LastTypeNode) ||
    TYPE_DECLARATIONS.has(raw.kind)
  );
}

const TYPE_DECLARATIONS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeParameter,
]);

/** A statement written with `declare`, which says what exists and runs nothing. */
function isAmbient(raw: ts.Node): boolean {
  if (!ts.canHaveModifiers(raw)) {
    return false;
  }
  return (
    ts
      .getModifiers(raw)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ??
    false
  );
}

/**
 * The ts-morph wrapper for a compiler node in the same file as `anchor`,
 * taken from the file's own cache, so it is the object every other pass
 * gets for that node.
 */
export function wrapperOf(anchor: Node, raw: ts.Node): Node {
  return (anchor as unknown as WrapsCompilerNodes)._getNodeFromCompilerNode(
    raw,
  );
}

/** The method ts-morph's own walks use to wrap a node of the same file. */
interface WrapsCompilerNodes {
  _getNodeFromCompilerNode(raw: ts.Node): Node;
}
