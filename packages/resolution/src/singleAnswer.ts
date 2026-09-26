/**
 * What counts as an answer to a question shaped `[key, answer]`, such as
 * `wantedIsWrittenAs` or `wantedSubjectWritten`. A call is written as
 * itself, so a call asked about directly always matches its own key; that
 * row is dropped before the count so one other answer settles it instead
 * of counting as two.
 *
 * A placeholder write, `client = None` before a guard fills it in, is
 * set aside the same way when the key has any other answer. A key
 * written only as a placeholder keeps it. `answersFor` also sets aside
 * a member that a subclass overrides, when the key reads it through
 * that subclass.
 *
 * A caller that can only use one answer takes `singleAnswers`; one with
 * something to say about a value written two ways takes `answersByKey`.
 */

import type { Database, Tuple } from "@suss/datalog";

const NO_PLACEHOLDERS: ReadonlySet<string> = new Set();

/** Every answer each key has, in the order the rows arrive, with the two drops above applied. */
export function answersByKey(
  rows: Iterable<Tuple>,
  placeholders: ReadonlySet<string> = NO_PLACEHOLDERS,
): Map<string, string[]> {
  const candidates = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = String(row[0]);
    const answer = String(row[1]);
    if (answer === key) {
      continue;
    }
    const set = candidates.get(key) ?? new Set<string>();
    set.add(answer);
    candidates.set(key, set);
  }

  const answers = new Map<string, string[]>();
  for (const [key, set] of candidates) {
    answers.set(key, withoutPlaceholders(set, placeholders));
  }
  return answers;
}

/**
 * The answers one key has, read through the relation's index on the
 * key column rather than a pass over every row. A caller asking about
 * one key at a time, which is every adapter asking at a call site,
 * pays for the key's own rows and nothing else.
 */
export function answersFor(
  db: Database,
  relation: string,
  key: string,
): string[] {
  const rows = db.lookup(relation, 0, key);
  if (rows.length === 0) {
    return [];
  }
  const placeholders = new Set(
    rows
      .map((row) => String(row[1]))
      .filter((answer) => db.has("placeholderValue", [answer])),
  );
  return withoutOverridden(
    db,
    key,
    answersByKey(rows, placeholders).get(key) ?? [],
  );
}

/** Where the rules list, for a read asked about, the members a nearer declaration overrides. */
export interface OverrideRelations {
  /** `[read, object, member]`: the object contains a member overriding this one. */
  readonly overridden: string;
  /** `[read, object, member]`: every member the read finds on each object. */
  readonly found: string;
}

/** The relations a plain `wanted` question fills. */
export const WANTED_OVERRIDES: OverrideRelations = {
  overridden: "wantedReadsOverridden",
  found: "wantedReadsMemberOn",
};

/**
 * The answers left once a member a nearer class overrides is set aside.
 * `admin.save` finds Admin's own `save` and the one Admin inherits from
 * User, and User's is set aside. A read whose object can also be a plain
 * User finds User's `save` on an object with no override, so it keeps
 * both. When nothing would be left, every answer stays.
 */
export function withoutOverridden(
  db: Database,
  key: string,
  answers: readonly string[],
  relations: OverrideRelations = WANTED_OVERRIDES,
): string[] {
  if (answers.length < 2) {
    return [...answers];
  }
  const overridden = objectsByMember(db, relations.overridden, key);
  if (overridden.size === 0) {
    return [...answers];
  }
  const found = objectsByMember(db, relations.found, key);
  const kept = answers.filter((answer) => {
    const overriddenOn = overridden.get(answer);
    if (overriddenOn === undefined) {
      return true;
    }
    return [...(found.get(answer) ?? [])].some(
      (object) => !overriddenOn.has(object),
    );
  });
  return kept.length > 0 ? kept : [...answers];
}

/** The objects each member is listed on, for one read. */
function objectsByMember(
  db: Database,
  relation: string,
  key: string,
): Map<string, Set<string>> {
  const byMember = new Map<string, Set<string>>();
  for (const row of db.lookup(relation, 0, key)) {
    const member = String(row[2]);
    const objects = byMember.get(member) ?? new Set<string>();
    objects.add(String(row[1]));
    byMember.set(member, objects);
  }
  return byMember;
}

/** The one answer each key settles on, for a caller that treats several as none. */
export function singleAnswers(
  rows: Iterable<Tuple>,
  placeholders: ReadonlySet<string> = NO_PLACEHOLDERS,
): Map<string, string> {
  const settled = new Map<string, string>();
  for (const [key, answers] of answersByKey(rows, placeholders)) {
    if (answers.length === 1) {
      settled.set(key, answers[0] as string);
    }
  }
  return settled;
}

/** The keys an adapter marked `placeholderValue`, for passing to `singleAnswers`. */
export function placeholderValues(db: Database): ReadonlySet<string> {
  return new Set(db.facts("placeholderValue").map((row) => String(row[0])));
}

function withoutPlaceholders(
  answers: ReadonlySet<string>,
  placeholders: ReadonlySet<string>,
): string[] {
  const kept = [...answers].filter((answer) => !placeholders.has(answer));
  if (kept.length === 0) {
    return [...answers];
  }
  return kept;
}
