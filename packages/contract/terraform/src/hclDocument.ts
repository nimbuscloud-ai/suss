/**
 * The one call into the HCL parser.
 *
 * The parser gives back what it read and what stopped it, and text it
 * could not read comes back as nothing rather than as an error. The
 * `try` is there for the case it does raise, which no input found so
 * far does.
 */

// The parser ships CommonJS, so ESM reaches it through the default.
import hcl2 from "hcl2-parser";

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
