/**
 * Tells the code of a SQL text apart from its literals, quoted names and
 * comments. A rewrite of a statement or a split of a dump into statements
 * looks at code only, since a `;` or a keyword inside a literal means
 * nothing to the grammar.
 */

/** A stretch of a statement the grammar reads as text rather than code. */
interface TextRun {
  /** One character past the end of the run. */
  end: number;
  /** Whether it is a comment rather than a literal or a quoted name. */
  comment: boolean;
}

/** What closes a run of text, by what opened it. */
const TEXT_RUNS: ReadonlyArray<{
  open: string;
  close: string;
  comment: boolean;
}> = [
  { open: "--", close: "\n", comment: true },
  { open: "/*", close: "*/", comment: true },
  { open: "'", close: "'", comment: false },
  { open: '"', close: '"', comment: false },
  { open: "`", close: "`", comment: false },
];

/** What opens and closes a Postgres dollar-quoted literal. */
const DOLLAR_TAG = /\$(?:[A-Za-z_]\w*)?\$/y;

/** The run of text that opens at `index`, or null when `index` is in code. */
function textRunAt(sql: string, index: number): TextRun | null {
  DOLLAR_TAG.lastIndex = index;
  const tag = DOLLAR_TAG.exec(sql)?.[0];
  if (tag !== undefined) {
    return { end: closingAt(sql, index + tag.length, tag), comment: false };
  }
  for (const run of TEXT_RUNS) {
    if (sql.startsWith(run.open, index)) {
      const from = index + run.open.length;
      return { end: closingAt(sql, from, run.close), comment: run.comment };
    }
  }
  return null;
}

/** One character past the closer, or the end when nothing closed it. */
function closingAt(sql: string, from: number, close: string): number {
  const at = sql.indexOf(close, from);
  return at === -1 ? sql.length : at + close.length;
}

/**
 * Which characters are code, as opposed to a literal, a quoted name or
 * a comment.
 */
export function codeMask(sql: string): boolean[] {
  const mask = new Array<boolean>(sql.length).fill(true);
  let index = 0;
  while (index < sql.length) {
    const run = textRunAt(sql, index);
    if (run === null) {
      index += 1;
      continue;
    }
    for (let at = index; at < run.end; at += 1) {
      mask[at] = false;
    }
    index = run.end;
  }
  return mask;
}

/** The index of the next token, past whitespace and comments. */
export function nextToken(sql: string, from: number): number {
  let index = from;
  while (index < sql.length) {
    if (/\s/.test(sql[index] ?? "")) {
      index += 1;
      continue;
    }
    const run = textRunAt(sql, index);
    if (run === null || !run.comment) {
      return index;
    }
    index = run.end;
  }
  return index;
}
