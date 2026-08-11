/**
 * @suss/datalog, a small semi-naïve Datalog evaluator with stratified
 * negation, and the rules engine behind suss's derived program facts:
 * reachable closures, wrapper resolution, throw propagation, origin
 * chains. Rules are plain data (`Rule`) rather than code, so the same
 * rules can later run on a faster engine, or be read on their own.
 *
 * It is pure TypeScript with no dependencies, because the npm-shipped
 * CLI cannot require a native binary. Negation is stratified, so a
 * negation cycle throws at evaluation time rather than quietly giving a
 * wrong answer. Joins are nested-loop with hash indexing on bound
 * positions, which suits the thousands of tuples extraction produces.
 */

import {
  chargeEvaluation,
  chargeRelationSizes,
  chargeRound,
  chargeRule,
  isProfiling,
} from "./profile.js";
import { tupleKey } from "./tupleKey.js";

export { deriveOnDemand, type OnDemandRules } from "./onDemand.js";
export {
  type EvaluationProfile,
  formatProfile,
  profileEvaluation,
  profileEvaluationAsync,
  type RuleCost,
} from "./profile.js";
export { tupleKey, tupleKeyParts } from "./tupleKey.js";

/** Tuple values. Callers intern richer identities (AST nodes, summaries) to atoms. */
export type Atom = string | number;

export type Tuple = readonly Atom[];

/** A term in a rule literal: a variable to bind or a constant to match. */
export type Term =
  | { type: "variable"; name: string }
  | { type: "constant"; value: Atom };

/** Shorthand constructors, so rules stay readable without a parser. */
export const variable = (name: string): Term => ({ type: "variable", name });
export const constant = (value: Atom): Term => ({ type: "constant", value });

export interface Literal {
  relation: string;
  terms: Term[];
  /**
   * Negation-as-failure. A negated literal matches when no fact in the
   * (fully evaluated, lower-stratum) relation unifies with it. Every
   * variable in a negated literal must be bound by a positive literal
   * earlier in the body.
   */
  negated: boolean;
}

export const lit = (relation: string, ...terms: Term[]): Literal => ({
  relation,
  terms,
  negated: false,
});

export const notLit = (relation: string, ...terms: Term[]): Literal => ({
  relation,
  terms,
  negated: true,
});

export interface Rule {
  head: { relation: string; terms: Term[] };
  body: Literal[];
}

export const rule = (
  relation: string,
  terms: Term[],
  body: Literal[],
): Rule => ({ head: { relation, terms }, body });

// ---------------------------------------------------------------------------
// Tuple store
// ---------------------------------------------------------------------------

const keyOf = (tuple: Tuple): string => tupleKey(tuple);

interface Relation {
  keys: Set<string>;
  tuples: Tuple[];
  /**
   * Column position, then value, then the tuples with that value. The value
   * is the atom itself: a Map already tells 1 from "1", so encoding it first
   * would build a string out of every node id on every lookup and buy
   * nothing. `tupleKey` is for a key built out of several values.
   */
  indexes: Map<number, Map<Atom, Tuple[]>>;
}

function addToBucket(index: Map<Atom, Tuple[]>, key: Atom, tuple: Tuple): void {
  const bucket = index.get(key);
  if (bucket === undefined) {
    index.set(key, [tuple]);
  } else {
    bucket.push(tuple);
  }
}

/** A set of facts per relation, with O(1) membership. */
export class Database {
  private readonly store = new Map<string, Relation>();

  private relation(name: string): Relation {
    const existing = this.store.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const created: Relation = {
      keys: new Set<string>(),
      tuples: [],
      indexes: new Map(),
    };
    this.store.set(name, created);
    return created;
  }

  /** Add a fact; returns true when the tuple is new. */
  add(relationName: string, tuple: Tuple): boolean {
    const relation = this.relation(relationName);
    const key = keyOf(tuple);
    if (relation.keys.has(key)) {
      // The caller now owns a fact it asserted, even one evaluation had
      // already derived, so retracting conclusions later must leave this
      // one alone. A rule deriving the same fact twice changes nothing.
      if (!isDeriving(this)) {
        claimFact(this, relationName, key);
      }
      return false;
    }
    relation.keys.add(key);
    relation.tuples.push(tuple);
    for (const [column, index] of relation.indexes) {
      const value = tuple[column];
      if (value !== undefined) {
        addToBucket(index, value, tuple);
      }
    }
    return true;
  }

  has(relationName: string, tuple: Tuple): boolean {
    return this.store.get(relationName)?.keys.has(keyOf(tuple)) ?? false;
  }

  facts(relationName: string): readonly Tuple[] {
    return this.store.get(relationName)?.tuples ?? [];
  }

  /**
   * The facts with `value` at `column`. Once one of a literal's terms
   * is already bound, the join uses this instead of scanning the whole
   * relation.
   *
   * A column is indexed the first time somebody asks for it and stays
   * up to date after that, so a relation nobody joins on this way never
   * gets an index.
   */
  lookup(relationName: string, column: number, value: Atom): readonly Tuple[] {
    const relation = this.store.get(relationName);
    if (relation === undefined) {
      return [];
    }
    let index = relation.indexes.get(column);
    if (index === undefined) {
      index = new Map();
      for (const tuple of relation.tuples) {
        const at = tuple[column];
        if (at !== undefined) {
          addToBucket(index, at, tuple);
        }
      }
      relation.indexes.set(column, index);
    }
    return index.get(value) ?? [];
  }

  /**
   * Remove facts from a relation. Returns how many were actually there.
   *
   * When a rule set uses negation, a new fact can invalidate an old
   * conclusion, so evaluation calls this to remove what it derived last
   * time. Callers rarely need it.
   */
  retract(relationName: string, tuples: Iterable<Tuple>): number {
    const relation = this.store.get(relationName);
    if (relation === undefined) {
      return 0;
    }
    const going = new Set<string>();
    for (const tuple of tuples) {
      const key = keyOf(tuple);
      if (relation.keys.has(key)) {
        going.add(key);
      }
    }
    if (going.size === 0) {
      return 0;
    }
    for (const key of going) {
      relation.keys.delete(key);
    }
    relation.tuples = relation.tuples.filter(
      (tuple) => !going.has(keyOf(tuple)),
    );
    // Dropping the indexes and letting the next lookup rebuild them is
    // cheaper than hunting through every bucket for the removed tuples.
    relation.indexes.clear();
    forgetFacts(this, relationName, going);
    return going.size;
  }

  size(relationName: string): number {
    return this.store.get(relationName)?.tuples.length ?? 0;
  }

  relationNames(): string[] {
    return [...this.store.keys()];
  }
}

// ---------------------------------------------------------------------------
// Stratification
// ---------------------------------------------------------------------------

/**
 * Assign each derived relation a stratum such that positive
 * dependencies never decrease the stratum and negative dependencies
 * strictly increase it. Iterates to fixpoint. A stratum above the
 * relation count means there is a negation cycle, which cannot be
 * stratified, so this throws.
 */
export function stratify(rules: Rule[]): Rule[][] {
  const derived = new Set(rules.map((r) => r.head.relation));
  const stratum = new Map<string, number>();
  for (const name of derived) {
    stratum.set(name, 0);
  }

  const bound = derived.size + 1;
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rules) {
      const head = r.head.relation;
      for (const body of r.body) {
        if (!derived.has(body.relation)) {
          continue; // base relation, always stratum 0
        }
        const required =
          (stratum.get(body.relation) ?? 0) + (body.negated ? 1 : 0);
        if ((stratum.get(head) ?? 0) < required) {
          if (required > bound) {
            throw new Error(
              `rules are not stratifiable: negation cycle through "${head}"`,
            );
          }
          stratum.set(head, required);
          changed = true;
        }
      }
    }
  }

  const maxStratum = Math.max(0, ...stratum.values());
  const strata: Rule[][] = Array.from({ length: maxStratum + 1 }, () => []);
  for (const r of rules) {
    strata[stratum.get(r.head.relation) ?? 0].push(r);
  }
  return strata.filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

type Bindings = Map<string, Atom>;

function unify(
  literal: Literal,
  tuple: Tuple,
  bindings: Bindings,
): Bindings | null {
  if (literal.terms.length !== tuple.length) {
    return null;
  }
  let next: Bindings | null = null;
  for (let i = 0; i < literal.terms.length; i++) {
    const term = literal.terms[i];
    const value = tuple[i];
    if (term.type === "constant") {
      if (term.value !== value) {
        return null;
      }
      continue;
    }
    const bound = (next ?? bindings).get(term.name);
    if (bound === undefined) {
      next = next ?? new Map(bindings);
      next.set(term.name, value);
      continue;
    }
    if (bound !== value) {
      return null;
    }
  }
  return next ?? bindings;
}

/** Instantiate a negated literal's tuple; every variable must be bound. */
function groundNegated(literal: Literal, bindings: Bindings): Tuple {
  return literal.terms.map((term) => {
    if (term.type === "constant") {
      return term.value;
    }
    const bound = bindings.get(term.name);
    if (bound === undefined) {
      throw new Error(
        `unbound variable "${term.name}" in negated literal "${literal.relation}": ` +
          "negated literals may only use variables bound by earlier positive literals",
      );
    }
    return bound;
  });
}

function headTuple(head: Rule["head"], bindings: Bindings): Tuple {
  return head.terms.map((term) => {
    if (term.type === "constant") {
      return term.value;
    }
    const bound = bindings.get(term.name);
    if (bound === undefined) {
      throw new Error(
        `unbound variable "${term.name}" in head of "${head.relation}"`,
      );
    }
    return bound;
  });
}

/**
 * Evaluate one rule with the `deltaIndex`-th positive literal drawn
 * from the delta set and every other positive literal from the full
 * database. Returns the derived head tuples.
 */
function evaluateRule(
  db: Database,
  deltas: Map<string, readonly Tuple[]>,
  r: Rule,
  deltaIndex: number,
): Tuple[] {
  const results: Tuple[] = [];

  const step = (
    literalIndex: number,
    positiveIndex: number,
    bindings: Bindings,
  ): void => {
    if (literalIndex === r.body.length) {
      results.push(headTuple(r.head, bindings));
      return;
    }
    const literal = r.body[literalIndex];

    if (literal.negated) {
      if (!db.has(literal.relation, groundNegated(literal, bindings))) {
        step(literalIndex + 1, positiveIndex, bindings);
      }
      return;
    }

    const source =
      positiveIndex === deltaIndex
        ? (deltas.get(literal.relation) ?? [])
        : boundSource(db, literal, bindings);
    for (const tuple of source) {
      const next = unify(literal, tuple, bindings);
      if (next !== null) {
        step(literalIndex + 1, positiveIndex + 1, next);
      }
    }
  };

  step(0, 0, new Map());
  return results;
}

/**
 * The facts worth trying for a literal. When one of its terms is
 * already fixed, either written as a constant or bound by an earlier
 * literal, the index on that column gives those facts directly.
 * Otherwise there is nothing to narrow by, so the join scans.
 */
function boundSource(
  db: Database,
  literal: Literal,
  bindings: Bindings,
): readonly Tuple[] {
  for (let column = 0; column < literal.terms.length; column++) {
    const term = literal.terms[column];
    const value =
      term.type === "constant" ? term.value : bindings.get(term.name);
    if (value !== undefined) {
      return db.lookup(literal.relation, column, value);
    }
  }
  return db.facts(literal.relation);
}

// ---------------------------------------------------------------------------
// Incremental re-evaluation
// ---------------------------------------------------------------------------

/**
 * What one rule set has worked out about a database, so a later call
 * with the same rules can pick up from there instead of starting over.
 * Kept off to the side rather than on Database, which stays a plain
 * fact store, and kept per rule set: two rule sets sharing a database
 * are each responsible for their own conclusions, and neither removes
 * the other's.
 */
interface RuleSetState {
  /**
   * How many facts each relation had when this rule set last finished,
   * or null when facts have been removed since, in which case the next
   * run has to start over.
   */
  marks: Map<string, number> | null;
  /**
   * Every fact this rule set derived, per relation, keyed so a caller
   * asserting the same fact can take it off the list. A tuple the
   * caller had already added never shows up here: `add` said it was
   * nothing new, so evaluation never claimed it.
   */
  derived: Map<string, Map<string, Tuple>>;
}

const evaluated = new WeakMap<Database, Map<string, RuleSetState>>();

/**
 * How many evaluate() calls a database is part-way through. While one is
 * running, a repeat add from a rule is a second derivation of the same
 * fact rather than the caller claiming it.
 *
 * This counts rather than flags: rules are data and evaluate() calls no
 * caller code, so nothing nests today, but if something ever did, the
 * inner call would clear a flag and the outer call would then treat its
 * own derivations as caller facts.
 */
const deriving = new Map<Database, number>();

function isDeriving(db: Database): boolean {
  return (deriving.get(db) ?? 0) > 0;
}

function statesFor(db: Database): Map<string, RuleSetState> {
  let states = evaluated.get(db);
  if (states === undefined) {
    states = new Map();
    evaluated.set(db, states);
  }
  return states;
}

/** The caller now owns this fact, so no rule set may take it back. */
function claimFact(db: Database, relation: string, key: string): void {
  const states = evaluated.get(db);
  if (states === undefined) {
    return;
  }
  for (const state of states.values()) {
    state.derived.get(relation)?.delete(key);
  }
}

/**
 * Facts left the database, so no rule set can resume from its old
 * fixpoint. Each rule set keeps its ledger of what it derived, since a
 * later run with negation still has to be able to retract those facts.
 */
function forgetFacts(db: Database, relation: string, keys: Set<string>): void {
  const states = evaluated.get(db);
  if (states === undefined) {
    return;
  }
  for (const state of states.values()) {
    state.marks = null;
    const ledger = state.derived.get(relation);
    if (ledger !== undefined) {
      for (const key of keys) {
        ledger.delete(key);
      }
    }
  }
}

const usesNegation = (rules: Rule[]): boolean =>
  rules.some((r) => r.body.some((l) => l.negated));

/**
 * Whether the last fixpoint can be built on. Positive rules are
 * monotone: new facts can only bring new conclusions, and everything
 * derived before is still true, so a delta pass finishes the job.
 *
 * Negation is not monotone. A new fact can make a negated literal stop
 * matching, which takes an old conclusion away, and a pass that only
 * adds can never do that. So those runs start by clearing what they
 * derived.
 */
function canResume(rules: Rule[], state: RuleSetState): boolean {
  return !usesNegation(rules) && state.marks !== null;
}

/** The facts added to each relation since the marks were taken. */
function factsSince(
  db: Database,
  marks: Map<string, number>,
): Map<string, readonly Tuple[]> {
  const added = new Map<string, readonly Tuple[]>();
  for (const name of db.relationNames()) {
    const all = db.facts(name);
    const mark = marks.get(name) ?? 0;
    if (all.length > mark) {
      added.set(name, all.slice(mark));
    }
  }
  return added;
}

function currentMarks(db: Database): Map<string, number> {
  const marks = new Map<string, number>();
  for (const name of db.relationNames()) {
    marks.set(name, db.size(name));
  }
  return marks;
}

/**
 * Evaluate `rules` over `db` to fixpoint, adding derived facts in
 * place. Rules are stratified first; within a stratum, semi-naïve
 * iteration joins each rule against the last round's delta so work is
 * proportional to new facts, not all facts.
 */
export function evaluate(db: Database, rules: Rule[]): Database {
  deriving.set(db, (deriving.get(db) ?? 0) + 1);
  try {
    return runRules(db, rules);
  } finally {
    const depth = (deriving.get(db) ?? 1) - 1;
    if (depth === 0) {
      deriving.delete(db);
    } else {
      deriving.set(db, depth);
    }
  }
}

/**
 * Empty these relations, and leave `rules` able to carry on from where
 * it got to.
 *
 * `retract` cannot do this. A fact leaving the database can take away a
 * conclusion drawn anywhere, so it sends the next run back to the base
 * facts. A caller here is saying something stronger than "these facts
 * are gone": nothing outside `relations` was derived from them, so what
 * is left is already the fixpoint and the next run has only the facts
 * that arrive after this to work through.
 *
 * That is what a demand-driven rule set gives a caller between
 * questions. Every relation `deriveOnDemand` restricts is derived under
 * a demand fact, so clearing the demand together with everything under
 * it costs one question's worth of derivation rather than every
 * question asked so far. The relations listed as complete keep their
 * contents, which are the answers a caller has already read.
 *
 * Any other rule set over the same database does start over, since a
 * relation it derived from may be one of these.
 */
export function clearRelations(
  db: Database,
  rules: Rule[],
  relations: readonly string[],
): void {
  for (const relation of relations) {
    db.retract(relation, [...db.facts(relation)]);
  }
  const state = statesFor(db).get(signatureOf(rules));
  if (state !== undefined) {
    state.marks = currentMarks(db);
  }
}

/**
 * What a rule set is called and how it stratifies, worked out once. A
 * store evaluating after every wave of facts runs the same array
 * thousands of times, and re-deriving these each time charges every
 * question for the size of the rule set.
 */
interface RuleSetShape {
  signature: string;
  name: string;
  derivedRelations: string[];
  strata: Rule[][];
}

const signatureOf = (rules: Rule[]): string => shapeOf(rules).signature;

const shapes = new WeakMap<Rule[], RuleSetShape>();

function shapeOf(rules: Rule[]): RuleSetShape {
  const known = shapes.get(rules);
  if (known !== undefined) {
    return known;
  }
  // Listing the relations a rule set derives is enough to tell two of them
  // apart in a report, and it stays readable where the rule JSON does not.
  const derivedRelations = [...new Set(rules.map((r) => r.head.relation))];
  const shape: RuleSetShape = {
    signature: JSON.stringify(rules),
    name: [...derivedRelations].sort().join(", "),
    derivedRelations,
    strata: stratify(rules),
  };
  shapes.set(rules, shape);
  return shape;
}

function runRules(db: Database, rules: Rule[]): Database {
  const {
    signature,
    name: ruleSetName,
    derivedRelations,
    strata,
  } = shapeOf(rules);
  chargeEvaluation(ruleSetName);
  const states = statesFor(db);
  const state: RuleSetState = states.get(signature) ?? {
    marks: null,
    derived: new Map(),
  };
  states.set(signature, state);

  // A rule set with negation has one right answer for the facts in the
  // database right now, and an earlier run may have concluded things that
  // answer leaves out. Retract those and work it out from the base facts.
  if (usesNegation(rules)) {
    for (const [relation, ledger] of state.derived) {
      db.retract(relation, ledger.values());
    }
    state.derived.clear();
  }

  const derived = state.derived;
  // Taken before any stratum runs, so a later stratum's seed picks up
  // what the strata below it just derived.
  const marks = canResume(rules, state) ? state.marks : undefined;

  for (const stratum of strata) {
    let delta = new Map<string, Tuple[]>();
    const derivedHere = new Set(stratum.map((r) => r.head.relation));

    const record = (relation: string, tuple: Tuple): void => {
      if (db.add(relation, tuple)) {
        addTo(delta, relation, tuple);
        let ledger = derived.get(relation);
        if (ledger === undefined) {
          ledger = new Map();
          derived.set(relation, ledger);
        }
        ledger.set(keyOf(tuple), tuple);
      }
    };

    // One rule against one delta. Profiling charges the rule here, where
    // both the time and the new tuples are in scope. Comparing the head
    // relation's size before and after is how we tell it found something.
    const runOneRule = (
      r: Rule,
      seed: Map<string, readonly Tuple[]>,
      deltaIndex: number,
    ): void => {
      if (!isProfiling()) {
        for (const tuple of evaluateRule(db, seed, r, deltaIndex)) {
          record(r.head.relation, tuple);
        }
        return;
      }
      const startedAt = performance.now();
      const before = db.size(r.head.relation);
      for (const tuple of evaluateRule(db, seed, r, deltaIndex)) {
        record(r.head.relation, tuple);
      }
      chargeRule(
        ruleSetName,
        r.head.relation,
        r.body.map((l) => (l.negated ? `!${l.relation}` : l.relation)),
        performance.now() - startedAt,
        db.size(r.head.relation) - before,
      );
    };

    const applyDelta = (
      seed: Map<string, readonly Tuple[]>,
      derivedOnly: boolean,
    ): void => {
      for (const r of stratum) {
        const positives = r.body.filter((l) => !l.negated);
        for (let i = 0; i < positives.length; i++) {
          const literal = positives[i];
          // Within one evaluation the base facts do not change, so only
          // this stratum's own relations can have a new delta. A resumed
          // run's seed delta is the exception: those are new base facts.
          if (derivedOnly && !derivedHere.has(literal.relation)) {
            continue;
          }
          if ((seed.get(literal.relation) ?? []).length === 0) {
            continue;
          }
          runOneRule(r, seed, i);
        }
      }
    };

    if (marks === undefined || marks === null) {
      // Seed round: naive evaluation with every positive literal drawn
      // from the full database.
      for (const r of stratum) {
        const all = new Map<string, readonly Tuple[]>();
        for (const l of r.body) {
          if (!l.negated) {
            all.set(l.relation, db.facts(l.relation));
          }
        }
        runOneRule(r, all, -1);
      }
      chargeRound(ruleSetName);
    } else {
      applyDelta(factsSince(db, marks), false);
      chargeRound(ruleSetName);
    }

    // Semi-naïve rounds.
    while (delta.size > 0) {
      const lastDelta: Map<string, readonly Tuple[]> = delta;
      delta = new Map();
      applyDelta(lastDelta, true);
      chargeRound(ruleSetName);
    }
  }

  state.marks = currentMarks(db);
  if (isProfiling()) {
    chargeRelationSizes(
      db.relationNames().map((name) => [name, db.size(name)]),
      derivedRelations,
    );
  }
  return db;
}

function addTo(
  buckets: Map<string, Tuple[]>,
  relation: string,
  tuple: Tuple,
): void {
  const bucket = buckets.get(relation);
  if (bucket === undefined) {
    buckets.set(relation, [tuple]);
  } else {
    bucket.push(tuple);
  }
}
