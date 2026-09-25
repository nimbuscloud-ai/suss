/**
 * The result shape a why session hands back, shared by every language
 * adapter so the CLI reads one type regardless of which adapter
 * answered. Each adapter follows its own source to a witness proof
 * over `RESOLUTION_RULES` and renders it through `explainResolutionProof`;
 * this is what that render comes back as.
 *
 * `explainResolvedKey` is the proof pass itself, for an adapter that
 * keeps its facts in a `Database` keyed by source location: it reruns
 * the rules with witnesses over a copy of those facts, reads the one
 * target the asked-about key resolves to, and renders the proof. An
 * adapter supplies how a key is said in a sentence and nothing else.
 */

import { evaluate, proofOf, rulesDeriving, witnesses } from "@suss/datalog";

import { explainResolutionProof, renderExplanation } from "./explain.js";

import type { Database, Rule } from "@suss/datalog";
import type { ResolutionExplanation, StepPhrase } from "./explain.js";

/** A value or function said the way an answer prints it. */
export interface ValueLocation {
  name: string;
  /** Relative to the session root when under it, absolute otherwise. */
  file: string;
  line: number;
}

/** What one witness re-evaluation cost, said rather than hidden. */
export interface ExplainStats {
  /** Facts the run had extracted, which the proof pass reran. */
  baseFacts: number;
  /** Facts the exhaustive pass derived on top of those. */
  derivedFacts: number;
  evaluateMs: number;
}

export interface WhyExplained {
  explanation: ResolutionExplanation;
  /** The chain's atoms, each said in source terms. */
  chain: string[];
  /** The chain and its reasons as printable lines. */
  lines: string[];
  target: ValueLocation;
  stats: ExplainStats;
}

export interface ExplainResolvedKeyOptions {
  /**
   * The facts the session extracted. The proof pass derives into them,
   * so nothing else may evaluate rules over this database.
   */
  db: Database;
  /** The resolution rules plus whatever the language adds to them. */
  rules: Rule[];
  /** The fact key of the value asked about. */
  key: string;
  /** Where a fact key was written, or null for one the session never indexed. */
  locate: (key: string) => ValueLocation | null;
  /** How to say a key that has no location, which is a file path. */
  displayPath: (key: string) => string;
  maxDepth?: number;
  phrases?: Record<string, StepPhrase>;
}

/**
 * The rules a proof of `resolves` can use. A proof pass runs without
 * demand, over every fact it was given, and the rules under an
 * allocation site join each site against every value when nothing
 * narrows them, so they are left out.
 */
export function proofRules(rules: readonly Rule[]): Rule[] {
  return rulesDeriving(rules, ["resolves"]);
}

/**
 * Why `key` resolves to what it does: the witness proof, flattened to
 * the chain and rendered. Null when the key resolves to nothing or to
 * more than one function, which the caller says in its own words.
 */
export function explainResolvedKey(
  options: ExplainResolvedKeyOptions,
): WhyExplained | null {
  const { db, rules, key, locate, displayPath } = options;

  const witnessRules = proofRules(rules);
  const started = performance.now();
  evaluate(db, witnessRules, witnesses);
  const evaluateMs = performance.now() - started;
  const { baseFacts, derivedFacts } = factCounts(db, witnessRules);

  const targets = new Set(
    db.lookup("resolves", 0, key).map((tuple) => String(tuple[1])),
  );
  if (targets.size !== 1) {
    return null;
  }
  const target = [...targets][0] as string;

  const proof = proofOf(
    db,
    "resolves",
    [key, target],
    options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth },
  );
  const describe = (atom: string | number): string => {
    const location = locate(String(atom));
    return location === null
      ? displayPath(String(atom))
      : `${location.name} (${location.file}:${location.line})`;
  };
  const explanation = explainResolutionProof(proof, {
    describe,
    ...(options.phrases === undefined ? {} : { phrases: options.phrases }),
  });
  if (explanation === null) {
    return null;
  }
  const targetLocation = locate(target);
  if (targetLocation === null) {
    return null;
  }
  return {
    explanation,
    chain: explanation.atoms.map(describe),
    lines: renderExplanation(explanation, describe),
    target: targetLocation,
    stats: { baseFacts, derivedFacts, evaluateMs },
  };
}

/** The facts in `db` the session read, and the ones `rules` derived. */
function factCounts(
  db: Database,
  rules: readonly Rule[],
): { baseFacts: number; derivedFacts: number } {
  const derived = new Set(rules.map((r) => r.head.relation));
  let baseFacts = 0;
  let derivedFacts = 0;
  for (const relation of db.relationNames()) {
    if (derived.has(relation)) {
      derivedFacts += db.size(relation);
    } else {
      baseFacts += db.size(relation);
    }
  }
  return { baseFacts, derivedFacts };
}
