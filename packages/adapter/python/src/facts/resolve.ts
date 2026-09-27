/**
 * Runs the shared resolution rules over this project's facts. The rules in
 * `@suss/resolution` are the same ones the TypeScript adapter runs, so a
 * Python value is followed the same way a TypeScript one is.
 */

import {
  allocationSitesOf,
  askResolution,
  askResolutionUnder,
  declaredTypesOf,
  resolutionProgram,
  resolutionUnderProgram,
  writtenValueOf as sharedWrittenValueOf,
  writtenValuesOf as sharedWrittenValuesOf,
  writtenValueUnder as sharedWrittenValueUnder,
  writtenValuesByKey,
} from "@suss/resolution";

import type { Database, OnDemandRules } from "@suss/datalog";

export { resolvedFunctions, settledFunction } from "@suss/resolution";

/** How many evaluations under an allocation site are running over each database. */
const evaluationsUnderSite = new WeakMap<Database, number>();

/**
 * Runs `read`, an evaluation under an allocation site. Settling a callee
 * on the way asks context-free questions, and asking them through the
 * context-free program would reset the site program between one site
 * question and the next, so each would start from nothing. The site
 * program is the same rules plus the site questions, so it gives the
 * same answers to a context-free question.
 */
export function evaluatingUnderSite<T>(db: Database, read: () => T): T {
  evaluationsUnderSite.set(db, (evaluationsUnderSite.get(db) ?? 0) + 1);
  try {
    return read();
  } finally {
    evaluationsUnderSite.set(db, (evaluationsUnderSite.get(db) ?? 1) - 1);
  }
}

/** The program a context-free question goes through right now. */
function programFor(db: Database): OnDemandRules {
  return (evaluationsUnderSite.get(db) ?? 0) > 0
    ? resolutionUnderProgram()
    : resolutionProgram();
}

/** Asks the rules to resolve these keys, and derives what follows. */
export function resolveCalls(db: Database, callKeys: readonly string[]): void {
  askResolution(db, callKeys, "wanted", programFor(db));
}

/**
 * Asks the rules only what these keys are written as, which leaves out
 * the walks behind every other answer `resolveCalls` would derive.
 */
function resolveWritten(db: Database, keys: readonly string[]): void {
  askResolution(db, keys, "wantedWritten", programFor(db));
}

/**
 * Asks which parameters end up as the variable name read off each of these
 * environment objects. A project has a handful of environment objects and
 * thousands of parameters, so the question is keyed on the objects, and
 * one answer covers every caller.
 */
export function resolveEnvObjects(
  db: Database,
  objectKeys: readonly string[],
): void {
  askResolution(db, objectKeys, "wantedEnvObject", programFor(db));
}

/**
 * The single expression a value was written as, when its receiver is the
 * instance built at `site`. A field that two constructions fill differently
 * has one value under each site and none without one.
 *
 * A question abandoned on its budget returns null. The pair stays marked
 * as asked, so a second caller gets null too without paying for it again.
 */
export function writtenValueUnder(
  db: Database,
  key: string,
  site: string,
): string | null {
  if (askResolutionUnder(db, [[key, site]]) === "abandoned") {
    return null;
  }
  return sharedWrittenValueUnder(db, key, site, (pairs) => {
    askResolutionUnder(db, pairs);
  });
}

/** Every construction of a class the run can see, as the keys to ask under. */
export function constructionSites(db: Database, classKey: string): string[] {
  askResolution(db, [classKey], "wantedSites", programFor(db));
  return allocationSitesOf(db, classKey);
}

/** The single expression a value was written as, asking the rules about `key` first. */
export function writtenValueOf(db: Database, key: string): string | null {
  resolveWritten(db, [key]);
  return sharedWrittenValueOf(db, key, (keys) => resolveWritten(db, keys));
}

/** Every expression a value was written as, for a caller that handles more than one. */
export function writtenValuesOf(db: Database, key: string): string[] {
  resolveWritten(db, [key]);
  return sharedWrittenValuesOf(db, key, (keys) => resolveWritten(db, keys));
}

/**
 * Asks about every one of these keys, and about the call each was written
 * as, so a later read of any of them is already settled. Each round of the
 * rules runs over the whole project's facts, so two rounds for the batch
 * replace two rounds per key.
 */
export function settleWrittenValues(
  db: Database,
  keys: readonly string[],
): void {
  if (keys.length === 0) {
    return;
  }
  resolveWritten(db, keys);
  writtenValuesByKey(db, keys, (behind) => resolveWritten(db, behind));
}

/** Where a name came from, for one construction: the module and the name that module exports it under. */
export interface SubjectOrigin {
  module: string;
  name: string;
}

/**
 * Where a name came from, through any aliases and re-exports the project
 * put between it and the import. Empty when nothing in the project
 * imports what the name refers to.
 */
export function originsOf(db: Database, nameKey: string): SubjectOrigin[] {
  askResolution(db, [nameKey], "wantedOrigin", programFor(db));
  return db
    .facts("wantedComesFrom")
    .filter((row) => String(row[0]) === nameKey)
    .map((row) => ({ module: String(row[1]), name: String(row[2]) }));
}

/**
 * Where the class a value's declarations give it came from, as the
 * origins every one of them shares. An alias lists each import on the
 * way to the library, so `SessionDep` in one file and `Session` in
 * another agree on the library's `Session` and on nothing else.
 */
export function declaredTypeOrigins(
  db: Database,
  key: string,
): SubjectOrigin[] {
  let shared: SubjectOrigin[] | null = null;
  for (const typeKey of declaredTypesOf(db, key, programFor(db))) {
    const origins = originsOf(db, typeKey);
    shared =
      shared === null
        ? origins
        : shared.filter((one) =>
            origins.some((other) => sameOrigin(one, other)),
          );
    if (shared.length === 0) {
      return [];
    }
  }
  return shared ?? [];
}

function sameOrigin(one: SubjectOrigin, other: SubjectOrigin): boolean {
  return one.module === other.module && one.name === other.name;
}

/** The call a value was built by, and where that call's callee came from. */
export interface SubjectConstruction {
  /** The value key of the call. A router index keys its constructions the same way. */
  constructionKey: string;
  origins: SubjectOrigin[];
}

/**
 * What each of these values was built by. A value written as exactly one
 * expression, and that expression a call whose callee came out of some
 * module, is a construction; anything else is left out of the result.
 *
 * A value written two different ways is left out rather than settled on
 * one of them, because keying a route on the wrong app is worse than
 * keying it on none.
 */
export function subjectConstructions(
  db: Database,
  valueKeys: readonly string[],
): Map<string, SubjectConstruction> {
  const found = new Map<string, SubjectConstruction>();
  if (valueKeys.length === 0) {
    return found;
  }

  const askSubjects = (keys: readonly string[]): void => {
    askResolution(db, keys, "wantedSubject", programFor(db));
  };
  askSubjects(valueKeys);
  const written = writtenValuesByKey(
    db,
    valueKeys,
    askSubjects,
    "wantedSubjectWritten",
  );

  const origins = originsByConstruction(db);
  for (const [valueKey, constructionKey] of written) {
    const from = origins.get(constructionKey);
    if (from !== undefined) {
      found.set(valueKey, { constructionKey, origins: from });
    }
  }
  return found;
}

/**
 * Where each construction's callee came from. The module and the name
 * follow from the call alone, so two subjects settling on the same
 * construction get the same pair and one entry covers both.
 */
function originsByConstruction(db: Database): Map<string, SubjectOrigin[]> {
  const origins = new Map<string, SubjectOrigin[]>();
  for (const row of db.facts("wantedSubjectConstruction")) {
    const construction = String(row[1]);
    const one = { module: String(row[2]), name: String(row[3]) };
    const listed = origins.get(construction) ?? [];
    if (
      !listed.some((was) => was.module === one.module && was.name === one.name)
    ) {
      listed.push(one);
    }
    origins.set(construction, listed);
  }
  return origins;
}

/**
 * The values an object contains under its own keys, in the order the source
 * writes them. Empty when nothing said what the object contains.
 */
export function containedValues(db: Database, objectKey: string): string[] {
  return db
    .facts("holdsProperty")
    .filter((row) => row[0] === objectKey)
    .map((row) => [String(row[1]), String(row[2])] as const)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, value]) => value);
}

/**
 * The facts that record a read passing a value on, by relation and the
 * column the value's key is in: a return or a yield, an argument, another
 * name or object taking it, or an expression whose value it may become.
 */
const PASSED_ON_IN: readonly (readonly [string, number])[] = [
  ["returnsValue", 1],
  ["yieldsValue", 1],
  ["callArg", 2],
  ["callKeywordArg", 2],
  ["binds", 1],
  ["endsHolding", 1],
  ["mayHold", 1],
  ["holdsProperty", 2],
  ["storesProperty", 2],
  ["writesProperty", 2],
  ["holdsUnderKey", 1],
  ["entersValue", 0],
  ["fallbackBranch", 1],
  ["readsKeyed", 1],
  ["readsKeyed", 2],
  ["entersAs", 1],
];

/**
 * Whether any read of the value at `key` passes it on, as the facts record
 * it. Reading a property off it counts too, since `app.router` hands out a
 * part of it, unless the property is called at once as a method.
 */
export function isPassedOn(db: Database, key: string): boolean {
  if (
    PASSED_ON_IN.some(
      ([relation, column]) => db.lookup(relation, column, key).length > 0,
    )
  ) {
    return true;
  }
  return db
    .lookup("readsProperty", 1, key)
    .some(
      (row) =>
        row[0] === undefined || db.lookup("call", 1, row[0]).length === 0,
    );
}

/** The object a call returns, when the rules settled it on one. */
export function objectReturnedBy(db: Database, callKey: string): string | null {
  const row = db.facts("wantedObjectOf").find((entry) => entry[0] === callKey);
  return row === undefined ? null : String(row[1]);
}
