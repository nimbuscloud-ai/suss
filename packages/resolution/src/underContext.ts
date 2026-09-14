/**
 * Reading an answer that was asked for under one allocation site.
 *
 * The context-free readers take a key and get everything the rules
 * settled it on. These take a key and a site, and get what the value is
 * when the receiver behind it is the one that site made, so two clients
 * of one class answer apart here and together context-free.
 *
 * Nothing is derived until `askResolutionUnder` has put the pair as a
 * question, the same way the context-free readers need `askResolution`.
 */

import { answersByKey, placeholderValues } from "./singleAnswer.js";

import type { Database } from "@suss/datalog";

function answersUnder(
  db: Database,
  relation: string,
  key: string,
  site: string,
): string[] {
  return db
    .lookup(relation, 0, key)
    .filter((row) => String(row[1]) === site)
    .map((row) => String(row[2]));
}

/** Every expression the value was written as under this site. */
export function isWrittenAsUnder(
  db: Database,
  key: string,
  site: string,
): string[] {
  return answersUnder(db, "wantedIsWrittenAsUnder", key, site);
}

/** Every function or object the value comes down to under this site. */
export function comesToUnder(
  db: Database,
  key: string,
  site: string,
): string[] {
  return answersUnder(db, "wantedComesToUnder", key, site);
}

/** Every object the value refers to under this site, sites included. */
export function objectOfUnder(
  db: Database,
  key: string,
  site: string,
): string[] {
  return answersUnder(db, "wantedObjectOfUnder", key, site);
}

/**
 * The single expression the value was written as under this site, under
 * the policy the context-free reader applies: two answers are ambiguity,
 * and ambiguity is nothing.
 */
export function writtenValueUnder(
  db: Database,
  key: string,
  site: string,
): string | null {
  const rows = isWrittenAsUnder(db, key, site).map((answer) => [key, answer]);
  const answers = answersByKey(rows, placeholderValues(db)).get(key) ?? [];
  return answers.length === 1 ? (answers[0] as string) : null;
}

/**
 * Every site a class was made at, once `askResolution` has asked
 * `wantedSites` about it. These are the sites to put a value question
 * under.
 */
export function allocationSitesOf(db: Database, cls: string): string[] {
  return db.lookup("wantedAllocatedAt", 0, cls).map((row) => String(row[1]));
}
