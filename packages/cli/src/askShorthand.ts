/**
 * The symbol form of a question, for somebody typing the same question
 * often. `<- src/dao.ts` is who calls it, `src/dao.ts ->` is what it
 * reaches, and a trailing `?` asks why.
 *
 * Operations are symbols because a boundary key contains `:`, `.`, `#`
 * and `/`, and a word like `reads` could be part of a path, so nothing
 * that could sit inside an operand can be the thing that splits it.
 * `<-`, `->`, `w<-`, `r<-` and a trailing `?` are the five, and each
 * one rewrites to exactly one written question, which is what the rest
 * of ask reads. No question can be asked in symbols that cannot
 * be asked in words.
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

/** `<- <unit>`, who calls it. */
const callersOf: Rewrite = (tokens) =>
  tokens[0] === "<-" && tokens.length === 2 ? `what calls ${tokens[1]}` : null;

/** `w<- <boundary>` and `r<- <boundary>`, who writes it and who reads it. */
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

/** `<unit> ->`, what it reaches, and `<unit> -> <boundary> ?`, why. */
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
