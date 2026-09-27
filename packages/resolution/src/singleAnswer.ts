/**
 * The one reader for an answer the rules derived, such as `wantedResolves`
 * or `wantedIsWrittenAs`. Adapters and the readers in this package read
 * every answer through it, so a policy is applied in one place and a new
 * policy is one edit.
 *
 * A placeholder write, `client = None` before a guard fills it in, is set
 * aside when the key has another answer. A member a subclass overrides is
 * set aside when the key reads it through that subclass; the demand
 * rewrite refuses negation, so that happens here rather than in a rule.
 * A written-as question also sets aside a key's match against itself,
 * since a call is written as itself. A function does come to itself, so
 * the other questions keep that row. DESIGN.md has the detail.
 */

import type { Database } from "@suss/datalog";

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
 * Every answer `key` has in a `[key, answer]` relation, in the order the
 * rows arrive, with placeholders and overridden members set aside. The
 * read goes through the relation's index on the key, so a caller asking
 * about one key pays for that key's rows and nothing else.
 */
export function answersFor(
  db: Database,
  relation: string,
  key: string,
  overrides: OverrideRelations = WANTED_OVERRIDES,
): string[] {
  return settle(db, key, answerColumn(db, relation, key), overrides);
}

/** `answersFor`, for a written-as question, with the key's match against itself set aside. */
export function writtenAnswersFor(
  db: Database,
  relation: string,
  key: string,
): string[] {
  const answers = answerColumn(db, relation, key).filter(
    (answer) => answer !== key,
  );
  return settle(db, key, answers, WANTED_OVERRIDES);
}

/**
 * `writtenAnswersFor` over a `[key, site, answer]` relation, for the
 * rows under one allocation site. Nothing lists overrides under a site,
 * so only the placeholder policy applies.
 */
export function writtenAnswersUnder(
  db: Database,
  relation: string,
  key: string,
  site: string,
): string[] {
  const answers = db
    .lookup(relation, 0, key)
    .filter((row) => String(row[1]) === site)
    .map((row) => String(row[2]))
    .filter((answer) => answer !== key);
  return settle(db, key, answers, null);
}

/**
 * Every function that calling this value runs: what the value resolves
 * to, and what a factory returned when the value was assigned from a
 * call. The two are settled together, so an override found through one
 * sets aside the member the other found.
 */
export function resolvedFunctions(db: Database, key: string): string[] {
  return settle(
    db,
    key,
    [
      ...answerColumn(db, "wantedResolves", key),
      ...answerColumn(db, "wantedGivesBack", key),
    ],
    WANTED_OVERRIDES,
  );
}

/** The one function calling this value runs, or null when it settles on none or on several. */
export function settledFunction(db: Database, key: string): string | null {
  const functions = resolvedFunctions(db, key);
  return functions.length === 1 ? (functions[0] as string) : null;
}

function answerColumn(db: Database, relation: string, key: string): string[] {
  return db.lookup(relation, 0, key).map((row) => String(row[1]));
}

/** Every answer policy, applied to one key's answers. */
function settle(
  db: Database,
  key: string,
  answers: readonly string[],
  overrides: OverrideRelations | null,
): string[] {
  const kept = withoutPlaceholders(db, [...new Set(answers)]);
  return overrides === null
    ? kept
    : withoutOverridden(db, key, kept, overrides);
}

function withoutPlaceholders(
  db: Database,
  answers: readonly string[],
): string[] {
  if (answers.length < 2) {
    return [...answers];
  }
  const kept = answers.filter(
    (answer) => !db.has("placeholderValue", [answer]),
  );
  return kept.length > 0 ? kept : [...answers];
}

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
