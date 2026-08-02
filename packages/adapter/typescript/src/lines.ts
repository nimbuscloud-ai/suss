import type { Node } from "ts-morph";

/**
 * One-based line numbers for a node's start and end.
 *
 * ts-morph's own `getStartLineNumber` counts newlines from position zero
 * of the file text on every call, so asking for the line of a node deep
 * in a large file costs the whole prefix. The TypeScript compiler already
 * keeps a line-start table on the source file and caches it after the
 * first request, so the same answer comes back from a binary search.
 */
export function startLineOf(node: Node): number {
  return lineAt(node, node.getStart());
}

export function endLineOf(node: Node): number {
  return lineAt(node, node.getEnd());
}

export function lineRangeOf(node: Node): { start: number; end: number } {
  return { start: startLineOf(node), end: endLineOf(node) };
}

function lineAt(node: Node, pos: number): number {
  return (
    node.getSourceFile().compilerNode.getLineAndCharacterOfPosition(pos).line +
    1
  );
}
