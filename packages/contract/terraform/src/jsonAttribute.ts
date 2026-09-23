/**
 * An attribute whose value is JSON.
 *
 * Several providers take a structure as a JSON string instead of as
 * blocks, such as a BigQuery table's schema or an ECS task's container
 * definitions. An author can write one as a literal string, usually a
 * heredoc, or as `jsonencode` over an HCL value, and the parser returns
 * the two very differently. This module turns both into the value the
 * provider receives.
 *
 * A value that a file or a variable supplies is not written in the
 * configuration, so it comes back as null and the caller records nothing.
 */

import { parseHclExpression } from "./hclDocument.js";

/** `${jsonencode(<expression>)}`, and nothing else around it. */
const JSON_ENCODE = /^\$\{\s*jsonencode\((.*)\)\s*\}$/s;

/**
 * The value an attribute writes as JSON, or null when the attribute is
 * missing or its value is known only at deploy time.
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
