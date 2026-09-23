/**
 * The symbol form of a question, for somebody who types the same question
 * often. `<- src/dao.ts` asks what calls it, `src/dao.ts ->` asks what it
 * reaches, and a trailing `?` asks why.
 *
 * The operators are symbols because a boundary key can contain `:`, `.`,
 * `#` and `/`, and a word like `reads` could be part of a path. A token
 * that can appear inside an operand could not split the question safely.
 * There are five: `<-`, `->`, `w<-`, `r<-` and a trailing `?`. Each one
 * expands to exactly one written question, and the rest of ask parses
 * only the written form, so every symbol question has a word form too.
 */

/** The written question this shorthand means, or null when it is not one. */
export function expandShorthand(raw: string): string | null {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
  if (tokens.length === 0) {
    return null;
  }
  for (const rewrite of REWRITES) {
    const written = rewrite(tokens);
    if (written !== null) {
      return written;
    }
  }
  return null;
}

/** Whether a question is written in symbols at all. */
export function looksLikeShorthand(raw: string): boolean {
  return /(^|\s)(w<-|r<-|<-)(\s|$)|(^|\s)->(\s|$)/.test(raw.trim());
}

type Rewrite = (tokens: string[]) => string | null;

/** `<- <unit>`: what calls the unit. */
const callersOf: Rewrite = (tokens) =>
  tokens[0] === "<-" && tokens.length === 2 ? `what calls ${tokens[1]}` : null;

/** `w<- <boundary>` and `r<- <boundary>`: what writes it and what reads it. */
const directionOf: Rewrite = (tokens) => {
  if (tokens.length !== 2) {
    return null;
  }
  const verb = DIRECTIONS[tokens[0] as string];
  return verb === undefined ? null : `what ${verb} ${tokens[1]}`;
};

const DIRECTIONS: Record<string, string | undefined> = {
  "w<-": "writes",
  "r<-": "reads",
};

/** `<unit> ->` asks what the unit reaches, and `<unit> -> <boundary> ?` asks why. */
const reachOf: Rewrite = (tokens) => {
  const arrow = tokens.indexOf("->");
  if (arrow !== 1 || tokens[0] === undefined) {
    return null;
  }
  const subject = tokens[0];
  const rest = tokens.slice(2);
  if (rest.length === 0) {
    return `what does ${subject} reach`;
  }
  if (rest.length === 2 && rest[1] === "?") {
    return `why does ${subject} reach ${rest[0]}`;
  }
  return null;
};

const REWRITES: readonly Rewrite[] = [callersOf, directionOf, reachOf];
