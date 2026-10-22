/** Reads the untyped tree node-sql-parser returns. */

export interface Node {
  type?: string;
  [key: string]: unknown;
}

export function asNode(value: unknown): Node | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Node)
    : null;
}

export function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * A column's name. The parser returns a bare name as a string and a
 * quoted or qualified one as a value node.
 */
export function columnName(value: unknown): string | null {
  const direct = stringOf(value);
  if (direct !== null) {
    return direct;
  }
  const node = asNode(value);
  if (node === null) {
    return null;
  }
  const own = stringOf(node.value);
  if (own !== null) {
    return own;
  }
  return node.expr === undefined ? null : columnName(node.expr);
}
