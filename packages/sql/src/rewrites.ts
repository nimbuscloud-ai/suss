/**
 * Rewrites a statement's code before it is parsed again, for spellings
 * the grammar rejects that do not change what the reader is after.
 */

import { codeMask } from "./textRuns.js";

/**
 * The statement with every match that starts in code rewritten. Rewriting
 * inside text would change the statement's meaning.
 */
export function replaceInCode(
  sql: string,
  pattern: RegExp,
  rewrite: (match: RegExpMatchArray) => string,
): string {
  const mask = codeMask(sql);
  let rewritten = "";
  let from = 0;
  for (const match of sql.matchAll(pattern)) {
    const at = match.index;
    if (at === undefined || mask[at] === false) {
      continue;
    }
    rewritten += sql.slice(from, at) + rewrite(match);
    from = at + match[0].length;
  }
  return rewritten + sql.slice(from);
}

/** A name a type can go by, quoted or bare. */
export const TYPE_WORD = String.raw`(?:"[^"]*"|\w+)`;

/** The optional length or precision after a type, as in `varchar(20)` or `numeric(10, 2)`. */
const TYPE_SIZE = String.raw`(?:\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?`;

/** The words after a type name the standard writes as more than one word, as in `double precision`. */
const TYPE_TAIL = String.raw`(?:\s+(?:precision|varying|with(?:out)?\s+time\s+zone))?`;

/** A type a statement can cast to, including a schema-qualified name and array dimensions. */
export const CAST_TYPE =
  `${TYPE_WORD}(?:\\s*\\.\\s*${TYPE_WORD})?` +
  `${TYPE_SIZE}${TYPE_TAIL}${TYPE_SIZE}(?:\\s*\\[\\s*\\])*`;
