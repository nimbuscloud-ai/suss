import {
  answersByKey,
  placeholderValues,
  singleAnswers,
} from "./singleAnswer.js";

import type { Database } from "@suss/datalog";

/**
 * The single expression a value was written as, once the caller has
 * asked the rules about `key`. A call to a project function is asked
 * about as well, through `ask`, so the answer is what that function
 * returns rather than the call itself.
 */
export function writtenValueOf(
  db: Database,
  key: string,
  ask: (keys: readonly string[]) => void,
): string | null {
  const answers = settledAs(db, key, ask);
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
  ask: (keys: readonly string[]) => void,
): string[] {
  const settled = settledAs(db, key, ask);
  return settled.length > 0 ? settled : writesLeft(db, key);
}

/** What the rules settled the key on, with a call to a project function followed to what it returns. */
function settledAs(
  db: Database,
  key: string,
  ask: (keys: readonly string[]) => void,
): string[] {
  const placeholders = placeholderValues(db);
  const direct =
    answersByKey(db.facts("wantedIsWrittenAs"), placeholders).get(key) ?? [];

  const calls = new Set(db.facts("call").map((row) => String(row[0])));
  const throughCalls = direct.filter((answer) => calls.has(answer));
  if (throughCalls.length === 0) {
    return direct;
  }

  ask(throughCalls);
  const deeper = singleAnswers(db.facts("wantedIsWrittenAs"), placeholders);
  // A step off a call, `Foo.new` or `list.freeze`, leaves the call and
  // what it comes down to as two answers that are the same one.
  return [
    ...new Set(
      direct.map((answer) =>
        calls.has(answer) ? (deeper.get(answer) ?? answer) : answer,
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
  const unstated = db
    .facts("writesUnstated")
    .some((row) => String(row[0]) === key);
  if (unstated) {
    return [];
  }
  const candidates =
    answersByKey(db.facts("mayHold"), placeholderValues(db)).get(key) ?? [];
  return candidates.length > 1 ? candidates : [];
}
