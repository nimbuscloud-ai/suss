/** A tree-sitter reader that asks the evaluator for the string. */
export function routePathOf(
  node: unknown,
  db: unknown,
  stringValueOf: (n: unknown, d: unknown) => string | null,
): string | null {
  return stringValueOf(node, db);
}
