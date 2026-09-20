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
  return answers.length === 1 ? (answers[0] as string) : null;
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

  const isCall = (answer: string): boolean =>
    db.lookup("call", 0, answer).length > 0;
  const throughCalls = [...direct.values()].flat().filter(isCall);
  if (throughCalls.length === 0) {
    return direct;
  }

  ask(throughCalls);
  return new Map(
    [...direct].map(([key, answers]) => [
      key,
      collapseCalls(answers, isCall, (call) =>
        singleAnswerFor(db, relation, call),
      ),
    ]),
  );
}

/** The one answer a key settles on once asked, or nothing for a key with several. */
function singleAnswerFor(
  db: Database,
  relation: string,
  key: string,
): string | undefined {
  const answers = answersFor(db, relation, key);
  return answers.length === 1 ? answers[0] : undefined;
}

/** A step off a call that keeps its value, `list.freeze`, leaves the call and what it comes down to as two answers that are the same one. */
function collapseCalls(
  direct: readonly string[],
  isCall: (answer: string) => boolean,
  deeper: (call: string) => string | undefined,
): string[] {
  return [
    ...new Set(
      direct.map((answer) =>
        isCall(answer) ? (deeper(answer) ?? answer) : answer,
      ),
    ),
  ];
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
