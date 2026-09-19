/**
 * An attribute whose value is JSON.
 *
 * Several providers take a structure as a string rather than as blocks:
 * a BigQuery table's schema, an ECS task's container definitions, an
 * IAM policy document. Terraform gives an author two ways to write one,
 * a literal string (usually a heredoc) and `jsonencode` over an HCL
 * value, and the two arrive at this reader looking nothing alike. This
 * turns both into the value the provider will see.
 *
 * A schema a file or a variable supplies is not written down anywhere
 * this can read, so it comes back as null and the caller records
 * nothing rather than guessing.
 */

// The parser ships CommonJS, so ESM reaches it through the default.
import hcl2 from "hcl2-parser";

/** `${jsonencode(<expression>)}`, and nothing else around it. */
const JSON_ENCODE = /^\$\{\s*jsonencode\((.*)\)\s*\}$/s;

/** The name the wrapped expression is parsed back under. */
const WRAPPER = "value";

/**
 * The value an attribute states as JSON, or null when the attribute is
 * missing or states something only a deploy can settle.
 */
export function jsonAttributeValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return null;
  }
  const literal = parseJson(value);
  if (literal !== null) {
    return literal;
  }
  const encoded = JSON_ENCODE.exec(value);
  return encoded === null ? null : parseHclExpression(encoded[1] as string);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * What an HCL expression evaluates to, read by giving the parser an
 * attribute to hang it on. `jsonencode` takes a list or an object
 * written in HCL, and the parser already reads both; what it hands back
 * for an interpolation it cannot settle is the text as written, which
 * is the same hole a name keeps.
 */
function parseHclExpression(expression: string): unknown {
  try {
    const [parsed] = hcl2.parseToObject(`${WRAPPER} = ${expression}`);
    return (parsed as Record<string, unknown> | undefined)?.[WRAPPER] ?? null;
  } catch {
    return null;
  }
}
