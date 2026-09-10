/**
 * What a call's callee is, and when the rules settle on nothing, why.
 *
 * `resolves` comes back with a function and stays quiet otherwise, and a
 * caller recording a gap needs the quiet cases told apart: a method on
 * what a caller passed in is a different stop from a method on a value
 * this run never read. So when the rules settle nothing, this walks down
 * the facts the value was built from, one construct at a time, until it
 * meets something that says where the value came from.
 *
 * Both halves are here because every language emits the same facts and
 * meets the same stops. The words for an outcome stay with a language.
 */

import { deriveOnDemand, evaluate } from "@suss/datalog";

import {
  ANSWER_RELATIONS,
  RESOLUTION_QUESTIONS,
  RESOLUTION_RULES,
} from "./index.js";

import type { Database, Rule } from "@suss/datalog";

/**
 * The rules rewritten so a relation is derived only where a question
 * reaches it. Built on the first question and kept, because the rewrite
 * does not depend on facts.
 */
let onDemand: ReturnType<typeof deriveOnDemand> | null = null;

function demandDrivenRules(): Rule[] {
  onDemand ??= deriveOnDemand(
    [...RESOLUTION_RULES, ...RESOLUTION_QUESTIONS],
    ANSWER_RELATIONS,
  );
  return onDemand.rules;
}

/**
 * Ask what these values come down to, then derive. Asking about every
 * value in a project costs seconds on a large one and settles questions
 * nobody has, so a caller lists the ones it needs.
 */
export function askResolution(db: Database, keys: Iterable<string>): void {
  const fresh = [...keys].filter((key) => !db.has("wanted", [key]));
  if (fresh.length === 0) {
    return;
  }
  for (const key of fresh) {
    db.add("wanted", [key]);
  }
  evaluate(db, demandDrivenRules());
}

/** What a value a call is made through turns out to be. */
export type CalleeOutcome =
  /** One function in this run. */
  | { readonly kind: "function"; readonly key: string }
  /** One object in this run, which is a class where a language writes classes as objects. */
  | { readonly kind: "object"; readonly key: string }
  /** More than one, so no single answer, and `sources` tells them apart. */
  | { readonly kind: "severalSources"; readonly sources: readonly string[] }
  /** A parameter, whose key is here so a caller can say whose parameter it is. */
  | { readonly kind: "callerSupplied"; readonly key: string }
  /** Something a dependency built, or a name from a module this run never read. */
  | { readonly kind: "outsideRun" }
  /** Built in this run by something the rules could not follow through. */
  | { readonly kind: "unsettled" }
  /** Nothing in this run says anything about it. */
  | { readonly kind: "undeclared" };

const UNDECLARED: CalleeOutcome = { kind: "undeclared" };
const UNSETTLED: CalleeOutcome = { kind: "unsettled" };
const OUTSIDE_RUN: CalleeOutcome = { kind: "outsideRun" };

/** What each of these callees is. One batch, so evaluation runs per wave rather than per callee. */
export function calleeOutcomes(
  db: Database,
  keys: readonly string[],
): Map<string, CalleeOutcome> {
  askAboutSources(db, keys);
  const reading = new Reading(db);
  const outcomes = new Map<string, CalleeOutcome>();
  for (const key of keys) {
    outcomes.set(key, reading.outcomeOf(key));
  }
  return outcomes;
}

/** What one callee is, for a caller with a single key in hand. */
export function calleeOutcomeOf(db: Database, key: string): CalleeOutcome {
  return calleeOutcomes(db, [key]).get(key) ?? UNDECLARED;
}

/**
 * Ask about the seeds, then about what the seeds nothing came back for
 * were built from, until nothing new turns up. One wave is one
 * evaluation, and the facts a wave reads are already there.
 */
function askAboutSources(db: Database, keys: readonly string[]): void {
  let wave = [...new Set(keys)];
  const asked = new Set(wave);
  while (wave.length > 0) {
    askResolution(db, wave);
    const next: string[] = [];
    for (const key of wave) {
      if (!decidedByCallers(db, key) && answersFor(db, key).length > 0) {
        continue;
      }
      for (const source of sourcesOf(db, key)) {
        if (!asked.has(source)) {
          asked.add(source);
          next.push(source);
        }
      }
    }
    wave = next;
  }
}

/** Every value a key could have been built from, whichever construct built it. */
function sourcesOf(db: Database, key: string): string[] {
  const base = db.lookup("readsProperty", 0, key)[0];
  if (base !== undefined) {
    return [String(base[1])];
  }
  const call = db.lookup("call", 0, key)[0];
  if (call !== undefined) {
    return [String(call[1])];
  }
  return writtenSourcesOf(db, key);
}

/**
 * The values written to a name. What a call put in a parameter is left
 * out on purpose: one caller's argument is not what every caller passes,
 * and a caller wanting them apart asks `paramAt`.
 */
const WRITE_RELATIONS = ["binds", "endsHolding", "mayHold"];

function writtenSourcesOf(db: Database, key: string): string[] {
  const found: string[] = [];
  for (const relation of WRITE_RELATIONS) {
    for (const row of db.lookup(relation, 0, key)) {
      found.push(String(row[1]));
    }
  }
  return found;
}

/** The functions and objects the rules settled a key on, without repeats. */
function answersFor(db: Database, key: string): CalleeOutcome[] {
  const found = new Map<string, CalleeOutcome>();
  for (const row of db.lookup("wantedComesTo", 0, key)) {
    const answer = String(row[1]);
    if (db.has("func", [answer])) {
      found.set(answer, { kind: "function", key: answer });
      continue;
    }
    if (db.has("objectValue", [answer])) {
      found.set(answer, { kind: "object", key: answer });
    }
  }
  return [...found.values()];
}

/** How two outcomes are told apart when the sources of one value are compared. */
function outcomeKey(outcome: CalleeOutcome): string {
  if (outcome.kind === "function" || outcome.kind === "object") {
    return `${outcome.kind}:${outcome.key}`;
  }
  return outcome.kind;
}

/** A base the rules did settle leaves the member undeclared; every other stop passes along. */
const THROUGH_BASE: Partial<Record<CalleeOutcome["kind"], CalleeOutcome>> = {
  function: UNDECLARED,
  object: UNDECLARED,
};

/** A call on a function this run read gives back a value the rules cannot see. */
const THROUGH_CALL: Partial<Record<CalleeOutcome["kind"], CalleeOutcome>> = {
  function: UNSETTLED,
  object: UNSETTLED,
};

/** An outcome, and whether the walk that reached it turned back on itself. */
interface Found {
  outcome: CalleeOutcome;
  looped: boolean;
}

/**
 * One pass over one database. An outcome worked out under a loop is left
 * out of the memo, since the loop rather than the facts cut it short.
 */
class Reading {
  private readonly memo = new Map<string, CalleeOutcome>();
  private readonly walking = new Set<string>();

  constructor(private readonly db: Database) {}

  outcomeOf(key: string): CalleeOutcome {
    return this.walk(key).outcome;
  }

  private walk(key: string): Found {
    const known = this.memo.get(key);
    if (known !== undefined) {
      return { outcome: known, looped: false };
    }
    if (this.walking.has(key)) {
      return { outcome: UNDECLARED, looped: true };
    }
    this.walking.add(key);
    const found = this.decide(key);
    this.walking.delete(key);
    if (!found.looped) {
      this.memo.set(key, found.outcome);
    }
    return found;
  }

  private decide(key: string): Found {
    if (decidedByCallers(this.db, key)) {
      return this.fromWrites(key);
    }
    const answers = answersFor(this.db, key);
    if (answers.length > 1) {
      return {
        outcome: { kind: "severalSources", sources: answers.map(outcomeKey) },
        looped: false,
      };
    }
    const only = answers[0];
    if (only !== undefined) {
      return { outcome: only, looped: false };
    }
    return this.refusal(key);
  }

  private refusal(key: string): Found {
    const base = this.db.lookup("readsProperty", 0, key)[0];
    if (base !== undefined) {
      return this.through(THROUGH_BASE, String(base[1]));
    }
    const call = this.db.lookup("call", 0, key)[0];
    if (call !== undefined) {
      return this.through(THROUGH_CALL, String(call[1]));
    }
    return this.fromWrites(key);
  }

  private through(
    table: Partial<Record<CalleeOutcome["kind"], CalleeOutcome>>,
    source: string,
  ): Found {
    const found = this.walk(source);
    return {
      outcome: table[found.outcome.kind] ?? found.outcome,
      looped: found.looped,
    };
  }

  /**
   * What the writes to a name, and the arguments a call put in a
   * parameter, agree the value is. A source that says nothing is left
   * out, so a name narrowed through a second name keeps the outcome it
   * started with rather than counting as a second source.
   */
  private fromWrites(key: string): Found {
    const found = new Map<string, CalleeOutcome>();
    let looped = false;
    for (const source of writtenSourcesOf(this.db, key)) {
      const from = this.walk(source);
      looped = looped || from.looped;
      if (from.outcome.kind !== "undeclared") {
        found.set(outcomeKey(from.outcome), from.outcome);
      }
    }
    if (isParameter(this.db, key)) {
      found.set("callerSupplied", { kind: "callerSupplied", key });
    }
    if (found.size > 1) {
      return {
        outcome: { kind: "severalSources", sources: [...found.keys()] },
        looped,
      };
    }
    const only = [...found.values()][0];
    return { outcome: only ?? whereItCameFrom(this.db, key), looped };
  }
}

/** A parameter, so whichever function runs this call decides what the value is. */
function isParameter(db: Database, key: string): boolean {
  return (
    db.lookup("paramNamed", 2, key).length > 0 ||
    db.lookup("paramOf", 2, key).length > 0
  );
}

/**
 * A parameter whose value every caller decides. Following the arguments
 * one caller wrote would answer for all of them, which is the question
 * `paramAt` exists for. A parameter an adapter states a value for, a
 * method's receiver say, is not one of these.
 */
function decidedByCallers(db: Database, key: string): boolean {
  return isParameter(db, key) && db.lookup("binds", 0, key).length === 0;
}

/**
 * The last thing a value can say about itself once no source did: the
 * module it was imported from, when this run never read that module, or
 * that it is written out where it is used, which makes a method on it
 * the language's rather than this run's.
 */
function whereItCameFrom(db: Database, key: string): CalleeOutcome {
  for (const row of db.lookup("imports", 0, key)) {
    if (db.lookup("exportsAs", 0, String(row[1])).length === 0) {
      return OUTSIDE_RUN;
    }
  }
  if (db.has("writtenValue", [key])) {
    return OUTSIDE_RUN;
  }
  return db.has("writesUnstated", [key]) ? UNSETTLED : UNDECLARED;
}
