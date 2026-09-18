/**
 * The rules an adapter evaluates, and how a question is put to them.
 *
 * A demand-rewritten rule set is named by its shape, so two adapters
 * that build the same array share one evaluation state and clearing
 * under one of them resets the other. Every adapter builds its program
 * here instead, and a language that states rules of its own gets one
 * program of its own to pass around.
 */

import {
  BudgetExhausted,
  chargeAbandoned,
  chargeQuestion,
  clearRelations,
  deriveOnDemand,
  evaluate,
  rowBudget,
  tupleKey,
} from "@suss/datalog";

import {
  ANSWER_RELATIONS,
  RESOLUTION_QUESTIONS,
  RESOLUTION_RULES,
  UNDER_ANSWER_RELATIONS,
} from "./index.js";

import type { Database, OnDemandRules, Rule } from "@suss/datalog";

/**
 * The facts that say somebody is asking. Each seeds one family of
 * questions, and none of them is derived, so these are what a caller
 * adds and what it takes back once it has read the answer.
 */
export const ASKING_RELATIONS: readonly string[] = [
  "wanted",
  "wantedUnder",
  "wantedSites",
  "wantedEnvObject",
  "wantedOrigin",
  "wantedCallOrigin",
  "wantedExportsOf",
  "wantedSubject",
  "wantedAnchor",
  "wantedAncestry",
];

const NO_LANGUAGE_RULES: readonly Rule[] = [];

const programs = new WeakMap<readonly Rule[], OnDemandRules>();
const underPrograms = new WeakMap<readonly Rule[], OnDemandRules>();

// Read when a program is built rather than when this module loads,
// since the module it comes from re-exports this one.
const contextFreeAnswers = (): readonly string[] =>
  ANSWER_RELATIONS.filter(
    (relation) => !UNDER_ANSWER_RELATIONS.includes(relation),
  );

function builtProgram(
  languageRules: readonly Rule[],
  cache: WeakMap<readonly Rule[], OnDemandRules>,
  complete: readonly string[],
): OnDemandRules {
  const built = cache.get(languageRules);
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
      : deriveOnDemand(rules, complete);
  cache.set(languageRules, program);
  return program;
}

/**
 * The shared rules, whatever the language states of its own, and the
 * questions, rewritten so a relation is derived only where a question
 * reaches it. Built once per language and kept, because the rewrite
 * does not depend on the facts.
 *
 * The questions asked under an allocation site are left out, which
 * drops every rule behind them, so a caller that never mentions a
 * context pays nothing for the second closure.
 *
 * `SUSS_RESOLUTION_ON_DEMAND=0` runs the same rules unrestricted. Both
 * settings give the same answers; they differ in how much never gets
 * derived at all.
 */
export function resolutionProgram(
  languageRules: readonly Rule[] = NO_LANGUAGE_RULES,
): OnDemandRules {
  return builtProgram(languageRules, programs, contextFreeAnswers());
}

/**
 * The same rules with the three questions under an allocation site
 * added, which is what `askResolutionUnder` evaluates.
 *
 * Running both programs over one database costs the context-free one
 * its resume state, so a caller with many context-free questions and a
 * few under a site is better off asking the context-free ones first.
 */
export function resolutionUnderProgram(
  languageRules: readonly Rule[] = NO_LANGUAGE_RULES,
): OnDemandRules {
  return builtProgram(languageRules, underPrograms, ANSWER_RELATIONS);
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

/** Which value-and-site pairs have been asked about, per database. */
const askedUnderByDb = new WeakMap<Database, Set<string>>();

/**
 * How many rows the joins may read for one question under a site.
 *
 * The biggest question a project could answer read 200k rows on the
 * largest public corpus target and 600k on the regression fixtures. A
 * question that cannot be answered walks every node under every context
 * and reads that much per rule, round after round, without settling.
 * The gap is wide enough for thirty times the biggest healthy question,
 * which is a few seconds before the walk is given up on.
 */
export const UNDER_QUESTION_ROW_BUDGET = 20_000_000;

/**
 * How many rows the joins may read for every under-question a run asks,
 * together.
 *
 * The per-question budget stops one question walking forever. It says
 * nothing about how many questions a project asks, and a value read
 * under every site of a class built in seventy places is seventy
 * questions, each a fixpoint of its own. Twenty of those at the
 * per-question limit is seven minutes, which is a hang however well
 * each behaved on its own.
 *
 * This is two runaway questions' worth, or sixty-six of the biggest
 * one measured. Past it a run keeps the context-free answer.
 */
export const UNDER_RUN_ROW_BUDGET = 40_000_000;

/** Whether a question was worked through, or given up on a budget. */
export type UnderOutcome = "answered" | "abandoned";

/** What the under-questions of one run have cost it so far. */
interface UnderSpend {
  rows: number;
  asked: number;
  abandoned: number;
  skipped: number;
}

const spentUnderByDb = new WeakMap<Database, UnderSpend>();

function spendOf(db: Database): UnderSpend {
  let spend = spentUnderByDb.get(db);
  if (spend === undefined) {
    spend = { rows: 0, asked: 0, abandoned: 0, skipped: 0 };
    spentUnderByDb.set(db, spend);
  }
  return spend;
}

/**
 * What the under-questions of this database have cost, for a caller
 * reporting on a run.
 */
export function underQuestionSpend(db: Database): Readonly<UnderSpend> {
  return { ...spendOf(db) };
}

/**
 * `askResolution` for a value read under one allocation site. Each pair
 * is a question of its own, so asking about a value under two sites is
 * two rows, and asking the same pair twice costs nothing.
 *
 * A question that runs past `questionBudget`, or one asked after the
 * run has spent `runBudget` on questions before it, is abandoned: the
 * rows it added come back out, the answer relations stay as empty as
 * they were, and the caller is told so it can keep the context-free
 * answer instead. The pair stays marked as asked either way, so nobody
 * pays for it twice.
 */
export function askResolutionUnder(
  db: Database,
  pairs: Iterable<readonly [string, string]>,
  program: OnDemandRules = resolutionUnderProgram(),
  questionBudget: number = UNDER_QUESTION_ROW_BUDGET,
  runBudget: number = UNDER_RUN_ROW_BUDGET,
): UnderOutcome {
  let asked = askedUnderByDb.get(db);
  if (asked === undefined) {
    asked = new Set();
    askedUnderByDb.set(db, asked);
  }
  const fresh = [...pairs].filter(
    ([key, site]) => !asked.has(tupleKey([key, site])),
  );
  if (fresh.length === 0) {
    return "answered";
  }
  const spend = spendOf(db);
  for (const [key, site] of fresh) {
    asked.add(tupleKey([key, site]));
  }
  spend.asked += 1;
  // Nothing is added to the database when the run is out, so there is
  // nothing to take back and the question costs a comparison.
  if (spend.rows >= runBudget) {
    spend.skipped += 1;
    chargeQuestion("skipped");
    return "abandoned";
  }
  for (const [key, site] of fresh) {
    db.add("wantedUnder", [key, site]);
  }
  const forget = queryFacts(program);
  const clearDerived = (): void => {
    if (forget.length > 0) {
      clearRelations(db, program.rules, forget);
    }
  };

  const budget = rowBudget(questionBudget);
  try {
    evaluate(db, program.rules, undefined, budget);
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) {
      throw error;
    }
    spend.rows += error.examined;
    spend.abandoned += 1;
    chargeQuestion("abandoned");
    // Clearing covers these when the rules are demand-driven, and this
    // covers them when they are not.
    db.retract("wantedUnder", fresh);
    clearDerived();
    chargeAbandoned(
      fresh.map(([key, site]) => `${key} under ${site}`).join(", "),
      error.examined,
    );
    return "abandoned";
  }
  spend.rows += budget.examined;
  chargeQuestion();
  clearDerived();
  return "answered";
}
