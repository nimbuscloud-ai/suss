import { answersFor } from "./singleAnswer.js";

import type { Database } from "@suss/datalog";

type Ask = (keys: readonly string[]) => void;

/**
 * Where a plain `wanted` question puts its answers. A caller asking
 * under another demand class, `wantedSubject`, passes that class's
 * relation instead and gets the same policy.
 */
const WRITTEN_AS = "wantedIsWrittenAs";

/**
 * The single expression a value was written as, once the caller has
 * asked the rules about `key`. A call to a project function is asked
 * about as well, through `ask`, so the answer is what that function
 * returns rather than the call itself.
 */
export function writtenValueOf(
  db: Database,
  key: string,
  ask: Ask,
  relation: string = WRITTEN_AS,
): string | null {
  const answers = settledByKey(db, [key], ask, relation).get(key) ?? [];
  if (answers.length === 1) {
    return answers[0] as string;
  }
  return relation === WRITTEN_AS ? fallbackWrittenAs(db, key, ask) : null;
}

/** Where a plain `wanted` question puts the fallbacks a value passes. */
const FALLBACK_BEHIND = "wantedFallbackBehind";

/**
 * The fallback, `a or b`, that a value was written as, when the rules
 * found several expressions and every one of them came through that
 * fallback. A value reader then reads the fallback whole, and its own
 * `or` decides: a branch it cannot read makes no claim, and two branches
 * it can read both count. `writtenValuesOf` still lists the branches, for
 * a caller that wants each one.
 *
 * When one fallback is inside another, the outer one is returned. Null
 * when no fallback covers all of them, as for a name that two plain
 * writes leave with two values.
 */
export function fallbackWrittenAs(
  db: Database,
  key: string,
  ask: Ask,
): string | null {
  const answers = new Set(answersFor(db, WRITTEN_AS, key));
  const fallbacks = answersFor(db, FALLBACK_BEHIND, key);
  if (answers.size < 2 || fallbacks.length === 0) {
    return null;
  }
  ask(fallbacks);
  const covering = fallbacks.filter((fallback) =>
    sameAnswers(answersFor(db, WRITTEN_AS, fallback), answers),
  );
  const outermost = covering.filter((fallback) => {
    const inside = new Set(answersFor(db, FALLBACK_BEHIND, fallback));
    return covering.every((other) => other === fallback || inside.has(other));
  });
  return outermost.length === 1 ? (outermost[0] as string) : null;
}

function sameAnswers(
  answers: readonly string[],
  expected: ReadonlySet<string>,
): boolean {
  const found = new Set(answers);
  return (
    found.size === expected.size &&
    [...found].every((answer) => expected.has(answer))
  );
}

/**
 * Every expression a value was written as. More than one is a value with
 * more than one possible source, which a caller says something about at
 * the site rather than reading as the same nothing as a chain that went
 * nowhere.
 */
export function writtenValuesOf(
  db: Database,
  key: string,
  ask: Ask,
  relation: string = WRITTEN_AS,
): string[] {
  const settled = settledByKey(db, [key], ask, relation).get(key) ?? [];
  return settled.length > 0 ? settled : writesLeft(db, key);
}

/**
 * The one expression each key was written as, for a caller with several
 * keys at once. Keys the rules settled on nothing, or on more than one
 * expression, are left out. One round of asking covers them all, which
 * is what a caller gets here that a loop over `writtenValueOf` would
 * not.
 */
export function writtenValuesByKey(
  db: Database,
  keys: readonly string[],
  ask: Ask,
  relation: string = WRITTEN_AS,
): Map<string, string> {
  const one = new Map<string, string>();
  for (const [key, answers] of settledByKey(db, keys, ask, relation)) {
    if (answers.length === 1) {
      one.set(key, answers[0] as string);
    }
  }
  return one;
}

/** What the rules settled each key on, with a call to a project function followed to what it returns. */
function settledByKey(
  db: Database,
  keys: readonly string[],
  ask: Ask,
  relation: string,
): Map<string, string[]> {
  const direct = new Map(
    keys.map((key) => [key, answersFor(db, relation, key)]),
  );

  const throughCalls = [...direct.values()]
    .flat()
    .filter((answer) => isCall(db, answer));
  if (throughCalls.length === 0) {
    return direct;
  }

  ask(throughCalls);
  return new Map(
    [...direct].map(([key, answers]) => [
      key,
      collapseCalls(db, relation, answers),
    ]),
  );
}

function isCall(db: Database, key: string): boolean {
  return db.lookup("call", 0, key).length > 0;
}

/** A step off a call that keeps its value, `list.freeze`, leaves the call and what it comes down to as two answers that are the same one. */
function collapseCalls(
  db: Database,
  relation: string,
  direct: readonly string[],
): string[] {
  return [
    ...new Set(
      direct.map((answer) =>
        isCall(db, answer) ? behindCall(db, relation, answer) : answer,
      ),
    ),
  ];
}

/** What an asked-about call comes down to, or the call itself when the rules settled on nothing or on several. */
function behindCall(db: Database, relation: string, call: string): string {
  const answers = answersFor(db, relation, call);
  return answers.length === 1 ? (answers[0] as string) : call;
}

/**
 * What the writes to a name put there, for a name the rules settled on
 * nothing. Fewer than two, or a write that stated no value at all, and
 * `valueLeftByWrites` already declined this name for a reason of its
 * own that reading the writes here would go behind.
 */
function writesLeft(db: Database, key: string): string[] {
  if (db.has("writesUnstated", [key])) {
    return [];
  }
  const candidates = answersFor(db, "mayHold", key);
  return candidates.length > 1 ? candidates : [];
}
