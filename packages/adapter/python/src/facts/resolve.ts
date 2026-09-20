// resolve.ts: run the shared resolution rules over this project's facts.
// The rules live in @suss/resolution and are the same ones the TypeScript
// adapter evaluates, so a Python value is followed the way any value is.

import {
  allocationSitesOf,
  askResolution,
  askResolutionUnder,
  writtenValueOf as sharedWrittenValueOf,
  writtenValuesOf as sharedWrittenValuesOf,
  writtenValueUnder as sharedWrittenValueUnder,
  writtenValuesByKey,
} from "@suss/resolution";

import type { Database } from "@suss/datalog";

/** Ask what these calls come down to, then derive. */
export function resolveCalls(db: Database, callKeys: readonly string[]): void {
  askResolution(db, callKeys);
}

/**
 * Ask which parameters end up naming a variable read off each of these
 * environment objects. A project writes a handful of those and has
 * thousands of parameters, so the objects are what the question is
 * keyed on, and one of them covers every caller.
 */
export function resolveEnvObjects(
  db: Database,
  objectKeys: readonly string[],
): void {
  askResolution(db, objectKeys, "wantedEnvObject");
}

/**
 * Every function calling a value runs: what the value came down to, and
 * what a factory handed back when the value is a name for a call.
 * Asked once per call a body makes, so it joins on the index rather
 * than reading every answer the run has given.
 */
export function resolvedFunctions(db: Database, key: string): string[] {
  return [
    ...db.lookup("wantedResolves", 0, key),
    ...db.lookup("wantedGivesBack", 0, key),
  ].map((row) => String(row[1]));
}

/**
 * The single expression a value was written as when the receiver behind
 * it is the instance one site made. A field two constructions fill
 * differently settles here and not context free.
 *
 * A question abandoned on its budget gives back nothing. The pair
 * stays marked as asked, so a second caller gets the same nothing
 * without paying for it again.
 */
export function writtenValueUnder(
  db: Database,
  key: string,
  site: string,
): string | null {
  if (askResolutionUnder(db, [[key, site]]) === "abandoned") {
    return null;
  }
  return sharedWrittenValueUnder(db, key, site);
}

/** Every construction of a class the run can see, as the keys to ask under. */
export function constructionSites(db: Database, classKey: string): string[] {
  askResolution(db, [classKey], "wantedSites");
  return allocationSitesOf(db, classKey);
}

/** The single expression a value was written as, asking the rules about `key` first. */
export function writtenValueOf(db: Database, key: string): string | null {
  resolveCalls(db, [key]);
  return sharedWrittenValueOf(db, key, (keys) => resolveCalls(db, keys));
}

/** Every expression a value was written as, for a caller with something to say about two. */
export function writtenValuesOf(db: Database, key: string): string[] {
  resolveCalls(db, [key]);
  return sharedWrittenValuesOf(db, key, (keys) => resolveCalls(db, keys));
}

/**
 * Ask about every one of these keys, and about whatever call each of
 * them was written as, so a later read of any one of them finds its
 * answer already there. The rules run over the whole project's facts,
 * so the two rounds here take the place of two per key.
 */
export function settleWrittenValues(
  db: Database,
  keys: readonly string[],
): void {
  if (keys.length === 0) {
    return;
  }
  resolveCalls(db, keys);
  writtenValuesByKey(db, keys, (behind) => resolveCalls(db, behind));
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
  askResolution(db, [nameKey], "wantedOrigin");
  return db
    .facts("wantedComesFrom")
    .filter((row) => String(row[0]) === nameKey)
    .map((row) => ({ module: String(row[1]), name: String(row[2]) }));
}

/** The call a value was built by, and where that call's callee came from. */
export interface SubjectConstruction {
  /** The value key of the call, which is the key a router index keys its constructions by. */
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
    askResolution(db, keys, "wantedSubject");
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

/** What a call comes down to, when the rules settled it on an object. */
export function objectReturnedBy(db: Database, callKey: string): string | null {
  const row = db.facts("wantedObjectOf").find((entry) => entry[0] === callKey);
  return row === undefined ? null : String(row[1]);
}
