/**
 * The rules an adapter evaluates, and how a question is put to them.
 *
 * A demand-rewritten rule set is named by its shape, so two adapters
 * that build the same array share one evaluation state and clearing
 * under one of them resets the other. Every adapter builds its program
 * here instead, and a language that states rules of its own gets one
 * program of its own to pass around.
 */

import { clearRelations, deriveOnDemand, evaluate } from "@suss/datalog";

import {
  ANSWER_RELATIONS,
  RESOLUTION_QUESTIONS,
  RESOLUTION_RULES,
} from "./index.js";

import type { Database, OnDemandRules, Rule } from "@suss/datalog";

/**
 * The facts that say somebody is asking. Each seeds one family of
 * questions, and none of them is derived, so these are what a caller
 * adds and what it takes back once it has read the answer.
 */
export const ASKING_RELATIONS: readonly string[] = [
  "wanted",
  "wantedOrigin",
  "wantedCallOrigin",
  "wantedExportsOf",
  "wantedSubject",
  "wantedAnchor",
  "wantedAncestry",
];

const NO_LANGUAGE_RULES: readonly Rule[] = [];

const programs = new WeakMap<readonly Rule[], OnDemandRules>();

/**
 * The shared rules, whatever the language states of its own, and the
 * questions, rewritten so a relation is derived only where a question
 * reaches it. Built once per language and kept, because the rewrite
 * does not depend on the facts.
 *
 * `SUSS_RESOLUTION_ON_DEMAND=0` runs the same rules unrestricted. Both
 * settings give the same answers; they differ in how much never gets
 * derived at all.
 */
export function resolutionProgram(
  languageRules: readonly Rule[] = NO_LANGUAGE_RULES,
): OnDemandRules {
  const built = programs.get(languageRules);
  if (built !== undefined) {
    return built;
  }
  const rules = [
    ...RESOLUTION_RULES,
    ...languageRules,
    ...RESOLUTION_QUESTIONS,
  ];
  const program =
    process.env.SUSS_RESOLUTION_ON_DEMAND === "0"
      ? { rules, demandDriven: [], demands: [] }
      : deriveOnDemand(rules, ANSWER_RELATIONS);
  programs.set(languageRules, program);
  return program;
}

/**
 * What a caller takes back once it has read an answer: the question and
 * every relation derived under it. Empty when nothing is demand-driven,
 * since then the answers themselves are what clearing would remove.
 */
export function queryFacts(program: OnDemandRules): readonly string[] {
  if (program.demandDriven.length === 0) {
    return [];
  }
  return [...program.demandDriven, ...ASKING_RELATIONS];
}

/** Which keys have been asked about under which relation, per database. */
const askedByDb = new WeakMap<Database, Map<string, Set<string>>>();

function askedOf(db: Database, asking: string): Set<string> {
  let byRelation = askedByDb.get(db);
  if (byRelation === undefined) {
    byRelation = new Map();
    askedByDb.set(db, byRelation);
  }
  let asked = byRelation.get(asking);
  if (asked === undefined) {
    asked = new Set();
    byRelation.set(asking, asked);
  }
  return asked;
}

/**
 * Ask about these values, derive, and take the question back.
 *
 * Asking about everything in a project costs seconds on a large one and
 * settles questions nobody has, so a caller lists the keys it needs. The
 * answers stay in the database; the question and the chain that settled
 * it go, so the next question does not derive over every question asked
 * before it. What has already been asked is remembered, so asking twice
 * costs nothing. That wants every fact in the database before the first
 * question, which is how each adapter reads a project.
 */
export function askResolution(
  db: Database,
  keys: Iterable<string>,
  asking = "wanted",
  program: OnDemandRules = resolutionProgram(),
): void {
  const asked = askedOf(db, asking);
  const fresh = [...keys].filter((key) => !asked.has(key));
  if (fresh.length === 0) {
    return;
  }
  for (const key of fresh) {
    asked.add(key);
    db.add(asking, [key]);
  }
  evaluate(db, program.rules);
  const forget = queryFacts(program);
  if (forget.length > 0) {
    clearRelations(db, program.rules, forget);
  }
}
