/**
 * The one call into the HCL parser.
 *
 * The parser returns nothing for text it cannot read, without raising
 * an error. The `try` covers the case where it does raise, which no
 * input has triggered so far.
 *
 * A bare expression, such as the argument of a `jsonencode` or the
 * collection a `for_each` iterates over, is parsed by wrapping it in an
 * attribute. An interpolation the parser cannot resolve comes back as
 * the text as written, which leaves the same hole a name does.
 */

// The parser ships CommonJS, so ESM reaches it through the default.
import hcl2 from "hcl2-parser";

/** The attribute a bare expression is wrapped in for parsing. */
const WRAPPER = "value";

/** The parsed document, or null when the parser could not read it. */
export function parseHclDocument(
  source: string,
): Record<string, unknown> | null {
  let read: unknown;
  try {
    const [parsed] = hcl2.parseToObject(source);
    read = parsed;
  } catch {
    return null;
  }
  return typeof read === "object" && read !== null && !Array.isArray(read)
    ? (read as Record<string, unknown>)
    : null;
}

/** The value of one HCL expression, or null when the parser cannot read it. */
export function parseHclExpression(expression: string): unknown {
  return parseHclDocument(`${WRAPPER} = ${expression}`)?.[WRAPPER] ?? null;
}
