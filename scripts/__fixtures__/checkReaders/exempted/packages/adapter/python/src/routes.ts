/** A tree-sitter reader that strips the quotes itself. */
export function routePathOf(node: { type: string; text: string }): string {
  return node.text.slice(1, -1);
}
