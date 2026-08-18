/**
 * Running the rules over one fact base and writing down what came out.
 *
 * Every question a caller can ask is read, sorted so the order two runs
 * produce is the same order, and reduced to a digest. The digest is what
 * the snapshot compares, because the answers themselves run to hundreds
 * of tuples per base and nobody reads those until one moves.
 */

import { createHash } from "node:crypto";

import { Database, evaluate } from "@suss/datalog";
import { RESOLUTION_RULES } from "@suss/resolution";

import type { Fact, FactBase } from "./factBases.js";

/** Every question the rules answer, in the order a report prints them. */
export const QUESTIONS = [
  "comesTo",
  "givesBack",
  "isWrittenAs",
  "comesFrom",
  "objectOf",
  "resolves",
  "paramAt",
  "callsInto",
] as const;

export type Question = (typeof QUESTIONS)[number];

export interface Answers {
  readonly index: number;
  readonly facts: number;
  /** One question's tuples, each written as `a | b`, sorted. */
  readonly tuples: Readonly<Record<Question, string[]>>;
  readonly counts: Readonly<Record<Question, number>>;
  readonly digest: string;
}

const written = (fact: readonly (string | number)[]): string =>
  fact.map(String).join(" | ");

const sortedTuples = (db: Database, question: Question): string[] =>
  db.facts(question).map(written).sort();

/** Twelve hex characters: enough that two runs differing is the reason. */
function digestOf(tuples: Readonly<Record<Question, string[]>>): string {
  const hash = createHash("sha256");
  for (const question of QUESTIONS) {
    hash.update(question);
    hash.update("\n");
    for (const tuple of tuples[question]) {
      hash.update(tuple);
      hash.update("\n");
    }
  }
  return hash.digest("hex").slice(0, 12);
}

/** A database with the base's facts in it, and nothing derived yet. */
export function loaded(facts: readonly Fact[]): Database {
  const db = new Database();
  for (const [relation, ...tuple] of facts) {
    db.add(relation, tuple);
  }
  return db;
}

export function answersFor(base: FactBase): Answers {
  const db = evaluate(loaded(base.facts), RESOLUTION_RULES);
  const tuples = Object.fromEntries(
    QUESTIONS.map((question) => [question, sortedTuples(db, question)]),
  ) as Record<Question, string[]>;
  const counts = Object.fromEntries(
    QUESTIONS.map((question) => [question, tuples[question].length]),
  ) as Record<Question, number>;
  return {
    index: base.index,
    facts: base.facts.length,
    tuples,
    counts,
    digest: digestOf(tuples),
  };
}
