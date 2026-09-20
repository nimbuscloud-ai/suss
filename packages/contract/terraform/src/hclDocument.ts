/**
 * The one call into the HCL parser.
 *
 * The parser gives back what it read and what stopped it, and text it
 * could not read comes back as nothing rather than as an error. The
 * `try` is there for the case it does raise, which no input found so
 * far does.
 *
 * An expression written on its own, the argument of a `jsonencode` or
 * the collection a `for_each` iterates over, is read by giving the
 * parser an attribute to hang it on. What comes back for an
 * interpolation the parser cannot settle is the text as written, which
 * is the same hole a name keeps.
 */

// The parser ships CommonJS, so ESM reaches it through the default.
import hcl2 from "hcl2-parser";

/** The name a bare expression is parsed back under. */
const WRAPPER = "value";

/** What a piece of HCL states, or null when the parser could not read it. */
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

/** What one HCL expression evaluates to, or null when nothing settles it. */
export function parseHclExpression(expression: string): unknown {
  return parseHclDocument(`${WRAPPER} = ${expression}`)?.[WRAPPER] ?? null;
}
