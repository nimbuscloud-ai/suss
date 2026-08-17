/**
 * A name two sides state with a hole in it.
 *
 * A deployed resource is often called something built at deploy time:
 * a template writes `!Sub "${StageName}-orders-v1"` and the code writes
 * `` `${stage}-orders-v1` ``. Neither side states a string, both agree
 * about the fixed text, and each spells the parameter its own way. So a
 * name is written here as fixed text with `{}` holes, the way a REST
 * path is written with `{id}`, and two names agree when their fixed
 * parts line up.
 *
 * A hole covers a whole parameter rather than one path segment,
 * because a name has no separator that every project agrees on.
 */

/** What a hole looks like once a reader has written one. */
const HOLE = /\{[^}]*\}/g;

/** `${X}` is a hole. */
const SUB_TOKEN = /\$\{([^}]*)\}/g;

/** CloudFormation's escape for text that survives as a literal `${X}`. */
const SUB_ESCAPE = /\$\{!/;

/**
 * The name a CloudFormation `Fn::Sub` value states. The array form
 * takes its template from the first element, and the variable map only
 * says where a substitution comes from, which does not change the name.
 */
export function namePatternFromSub(value: unknown): string | null {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? namePatternFromSub(value[0]) : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  // A name with an escaped substitution in it keeps literal braces, and
  // braces are what a hole is written with here, so it has no pattern.
  if (SUB_ESCAPE.test(value)) {
    return null;
  }
  return value.replace(SUB_TOKEN, (_whole, inner: string) => `{${inner}}`);
}

/**
 * Whether a name says only that somebody else knows it. A wrapper that
 * takes its bucket as an argument states `{location.bucket}` and
 * nothing more, which says which parameter to ask rather than which
 * bucket. A name like that agrees with nothing until something grounds
 * it, since otherwise it would agree with every name there is.
 */
export function namesNothing(name: string): boolean {
  return /^\{[^}]*\}$/.test(name);
}

/** Whether a name has anything a source left for deploy time to fill. */
export function hasNameHole(name: string): boolean {
  HOLE.lastIndex = 0;
  return HOLE.test(name);
}

/**
 * The form two patterns are compared in: every hole reduced to the same
 * token, since the two sides pick their own name for the parameter.
 */
export function namePatternKey(name: string): string {
  return name.replace(HOLE, "{}");
}

/** Whether a concrete name has the pattern's fixed text in those places. */
function admits(pattern: string, name: string): boolean {
  const source = pattern
    .split(/(\{[^}]*\})/)
    .map((part) =>
      part.startsWith("{") && part.endsWith("}")
        ? ".+"
        : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`).test(name);
}

/**
 * Whether two names are the same name. Two patterns agree when their
 * fixed parts line up, since a hole on one side meets a hole on the
 * other. A pattern and a concrete name agree when the fixed parts are
 * where the pattern says they are, which is what happens when one side
 * hardcoded what the other parameterized.
 */
export function namesAgree(a: string, b: string): boolean {
  if (namesNothing(a) || namesNothing(b)) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const aHasHole = hasNameHole(a);
  const bHasHole = hasNameHole(b);
  if (aHasHole && bHasHole) {
    return namePatternKey(a) === namePatternKey(b);
  }
  if (aHasHole) {
    return admits(a, b);
  }
  if (bHasHole) {
    return admits(b, a);
  }
  return false;
}
