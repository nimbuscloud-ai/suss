// @suss/datalog — a small semi-naïve Datalog evaluator with stratified
// negation.
//
// This is the rules engine behind suss's derived program facts. The
// extraction pipeline accumulates analyses that are naturally fixpoint
// problems — reachable closures, multi-hop wrapper resolution,
// transitive throw propagation, origin chains. Expressed as rules over
// base facts, they share one small, testable fixpoint core — and
// because rule definitions are plain data, the same rules can later
// run on a faster external engine (or be audited independently of any
// engine at all).
//
// Design constraints, in order:
//   1. Pure TypeScript, zero dependencies — the npm-shipped CLI cannot
//      require a native binary.
//   2. Rules are data (`Rule`), not code. No embedded DSL strings.
//   3. Sound negation only: rules are stratified, and a negation cycle
//      is a hard error at evaluation time, never a wrong answer.
//
// Scale honesty: joins are nested-loop with hash indexing on bound
// positions. Fact sets in extraction are thousands of tuples, not
// millions; if that changes, the rule data model is the stable seam
// and the evaluator is the replaceable part.

/** Tuple values. Callers intern richer identities (AST nodes, summaries) to atoms. */
export type Atom = string | number;

export type Tuple = readonly Atom[];

/** A term in a rule literal: a variable to bind or a constant to match. */
export type Term =
  | { type: "variable"; name: string }
  | { type: "constant"; value: Atom };

/** Shorthand constructors — rules stay readable without a parser. */
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

// Tuple values can contain anything a caller interns, so the joined
// key uses a control character. Written as an escape so this file
// stays text to git rather than turning into a binary blob.
const SEP = "\u0000";

const atomKey = (a: Atom): string => `${typeof a === "number" ? "n" : "s"}${a}`;

const keyOf = (tuple: Tuple): string => tuple.map(atomKey).join(SEP);

interface Relation {
  keys: Set<string>;
  tuples: Tuple[];
  /** Column position, to value, to the tuples holding that value. */
  indexes: Map<number, Map<string, Tuple[]>>;
}

function addToBucket(
  index: Map<string, Tuple[]>,
  key: string,
  tuple: Tuple,
): void {
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
      // The caller is asserting a fact evaluation had already worked
      // out. It belongs to them from here, so taking conclusions back
      // later must not take this one.
      claimFact(this, relationName, key);
      return false;
    }
    relation.keys.add(key);
    relation.tuples.push(tuple);
    for (const [column, index] of relation.indexes) {
      const value = tuple[column];
      if (value !== undefined) {
        addToBucket(index, atomKey(value), tuple);
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
   * The facts holding `value` at `column`. A join reaches for this
   * instead of scanning the whole relation once one of its terms is
   * already bound.
   *
   * A column is indexed the first time somebody asks for it and stays
   * up to date after that, so a relation nobody joins on this way
   * carries no index at all.
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
          addToBucket(index, atomKey(at), tuple);
        }
      }
      relation.indexes.set(column, index);
    }
    return index.get(atomKey(value)) ?? [];
  }

  /**
   * Remove facts from a relation. Returns how many were actually there.
   *
   * Evaluation uses this to take back what it derived last time when a
   * rule set uses negation, where a new fact can invalidate an old
   * conclusion. Callers rarely need it.
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
    // Cheaper to drop the indexes and let the next lookup rebuild them
    // than to hunt through every bucket for the tuples that went.
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
 * strictly increase it. Iterates to fixpoint; a stratum exceeding the
 * relation count means a negation cycle — not stratifiable, hard error.
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
          continue; // base relation — always stratum 0
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
        `unbound variable "${term.name}" in negated literal "${literal.relation}" — ` +
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
 * The facts worth trying for a literal. When any of its terms is
 * already fixed, either written as a constant or bound by an earlier
 * literal, the index on that column answers directly. Otherwise there
 * is nothing to narrow by and the join scans.
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
 * What a database already worked out, so a later call with the same
 * rules can carry on from there instead of starting over. Held to the
 * side rather than on Database, which stays a plain fact store.
 */
/**
 * What one rule set has worked out about a database. Kept per rule
 * set: two rule sets sharing a database each answer for their own
 * conclusions, and neither takes the other's away.
 */
interface RuleSetState {
  /**
   * How many facts each relation held when this rule set last
   * finished, or null when facts have gone missing since and the next
   * run has to start over.
   */
  marks: Map<string, number> | null;
  /**
   * Every fact this rule set derived, per relation, keyed so a caller
   * asserting the same fact can take it off the list. A tuple the
   * caller had already added is never in here: `add` reported it as
   * nothing new, so evaluation never claimed it.
   */
  derived: Map<string, Map<string, Tuple>>;
}

const evaluated = new WeakMap<Database, Map<string, RuleSetState>>();

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
 * fixpoint. The ledger of what each derived survives, since a later
 * negated run still has to be able to take those facts back.
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
 * derived before still holds, so a delta pass finishes the job.
 *
 * Negation is not monotone. A new fact can make a negated literal stop
 * matching, which takes an old conclusion away, and a pass that only
 * adds can never do that. Those runs clear the board first instead.
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
  const signature = JSON.stringify(rules);
  const states = statesFor(db);
  const state: RuleSetState = states.get(signature) ?? {
    marks: null,
    derived: new Map(),
  };
  states.set(signature, state);

  // A rule set with negation has one right answer for the facts the
  // database holds now, and an earlier run of these rules may have
  // concluded things that answer does not include. Take those back and
  // work it out again from the base facts.
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

  for (const stratum of stratify(rules)) {
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

    const applyDelta = (
      seed: Map<string, readonly Tuple[]>,
      derivedOnly: boolean,
    ): void => {
      for (const r of stratum) {
        const positives = r.body.filter((l) => !l.negated);
        for (let i = 0; i < positives.length; i++) {
          const literal = positives[i];
          // Within one evaluation base facts hold still, so only the
          // relations this stratum derives can carry a new delta. The
          // seed round of a resumed run is the exception: that delta is
          // exactly the base facts the caller added since last time.
          if (derivedOnly && !derivedHere.has(literal.relation)) {
            continue;
          }
          if ((seed.get(literal.relation) ?? []).length === 0) {
            continue;
          }
          for (const tuple of evaluateRule(db, seed, r, i)) {
            record(r.head.relation, tuple);
          }
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
        for (const tuple of evaluateRule(db, all, r, -1)) {
          record(r.head.relation, tuple);
        }
      }
    } else {
      applyDelta(factsSince(db, marks), false);
    }

    // Semi-naïve rounds.
    while (delta.size > 0) {
      const lastDelta: Map<string, readonly Tuple[]> = delta;
      delta = new Map();
      applyDelta(lastDelta, true);
    }
  }

  state.marks = currentMarks(db);
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
