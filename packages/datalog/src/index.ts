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

import { isDemandRewritten } from "./onDemand.js";
import {
  chargeEvaluation,
  chargeRelationSizes,
  chargeRound,
  chargeRule,
  isProfiling,
} from "./profile.js";
import { tupleKey } from "./tupleKey.js";

export {
  type ConfidenceLevel,
  confidence,
  confidenceWith,
} from "./confidence.js";
export {
  type Demand,
  deriveOnDemand,
  type OnDemandRules,
} from "./onDemand.js";
export {
  type EvaluationProfile,
  formatProfile,
  profileEvaluation,
  profileEvaluationAsync,
  type RuleCost,
} from "./profile.js";
export { tupleKey, tupleKeyParts } from "./tupleKey.js";
export {
  type Proof,
  type ProofDerived,
  type ProofOptions,
  proofOf,
  Witness,
  type WitnessTag,
  witnesses,
} from "./witness.js";

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
  /** The name a proof shows for this rule. `ruleLabel` renders a default without it. */
  name?: string;
}

export const rule = (
  relation: string,
  terms: Term[],
  body: Literal[],
  name?: string,
): Rule =>
  name === undefined
    ? { head: { relation, terms }, body }
    : { head: { relation, terms }, body, name };

const literalName = (literal: Literal): string =>
  literal.negated ? `!${literal.relation}` : literal.relation;

/**
 * The label a proof prints for a rule: the name the caller gave it, or
 * the head and body relations, as in `path :- path, !blocked`. Two
 * rules over the same relations get the same default label, which is
 * why a witness keeps the `Rule` object itself and renders it only
 * when asked.
 */
export const ruleLabel = (r: Rule): string =>
  r.name ?? `${r.head.relation} :- ${r.body.map(literalName).join(", ")}`;

// ---------------------------------------------------------------------------
// Tuple store
// ---------------------------------------------------------------------------

// One tuple is keyed on the way in, again to retract it, and again for
// every membership test in between, so the key is remembered against
// the tuple itself.
const keys = new WeakMap<Tuple, string>();

const keyOf = (tuple: Tuple): string => {
  const known = keys.get(tuple);
  if (known !== undefined) {
    return known;
  }
  const key = tupleKey(tuple);
  keys.set(tuple, key);
  return key;
};

interface Relation {
  keys: Set<string>;
  tuples: Tuple[];
  /**
   * Tags, keyed like `keys`. The key is the tuple's own text, so a tag
   * cannot live in the tuple: an improved tag would read as a new fact
   * and the fixpoint would never close. Stays undefined until a caller
   * stores a tag, so evaluation without an algebra never allocates it.
   */
  tags: Map<string, unknown> | undefined;
  /**
   * Column position, then value, then the tuples with that value. The value
   * is the atom itself: a Map already tells 1 from "1", so encoding it first
   * would build a string out of every node id on every lookup and buy
   * nothing. `tupleKey` is for a key built out of several values.
   */
  indexes: Map<number, Map<Atom, Tuple[]>>;
}

function tagSlots(relation: Relation): Map<string, unknown> {
  if (relation.tags === undefined) {
    relation.tags = new Map();
  }
  return relation.tags;
}

function addToBucket(index: Map<Atom, Tuple[]>, key: Atom, tuple: Tuple): void {
  const bucket = index.get(key);
  if (bucket === undefined) {
    index.set(key, [tuple]);
  } else {
    bucket.push(tuple);
  }
}

/** What `add` did: a new fact, a better tag on an existing one, or nothing. */
export type AddOutcome = "added" | "improved" | "unchanged";

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
      tags: undefined,
      indexes: new Map(),
    };
    this.store.set(name, created);
    return created;
  }

  /**
   * Add a fact, or merge a tag into one already present. A new fact
   * stores `tag` when one is given. For a fact already present,
   * `merge` gets the stored tag (undefined when there is none) and the
   * incoming one; returning anything but the stored value stores the
   * result and reports "improved".
   */
  add(
    relationName: string,
    tuple: Tuple,
    tag?: unknown,
    merge?: (stored: unknown, incoming: unknown) => unknown,
  ): AddOutcome {
    const relation = this.relation(relationName);
    const key = keyOf(tuple);
    if (relation.keys.has(key)) {
      let outcome: AddOutcome = "unchanged";
      if (merge !== undefined) {
        const stored = relation.tags?.get(key);
        const merged = merge(stored, tag);
        if (merged !== stored) {
          tagSlots(relation).set(key, merged);
          outcome = "improved";
        }
      }
      // The caller now owns a fact it asserted, even one evaluation had
      // already derived, so retracting conclusions later must leave this
      // one alone. A rule deriving the same fact twice changes nothing.
      if (!isDeriving(this)) {
        claimFact(this, relationName, key);
      }
      return outcome;
    }
    relation.keys.add(key);
    relation.tuples.push(tuple);
    if (tag !== undefined) {
      tagSlots(relation).set(key, tag);
    }
    for (const [column, index] of relation.indexes) {
      const value = tuple[column];
      if (value !== undefined) {
        addToBucket(index, value, tuple);
      }
    }
    return "added";
  }

  /** The tag stored for this fact, or undefined when there is none. */
  tagOf(relationName: string, tuple: Tuple): unknown {
    return this.store.get(relationName)?.tags?.get(keyOf(tuple));
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
      relation.tags?.delete(key);
    }
    // Emptying a relation is what `clearRelations` does after every
    // question, and walking the tuples to find that none of them stay is
    // the slowest way to arrive at an empty list.
    relation.tuples =
      relation.keys.size === 0
        ? []
        : relation.tuples.filter((tuple) => !going.has(keyOf(tuple)));
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
// Tag algebra
// ---------------------------------------------------------------------------

/**
 * A provenance semiring (Green, Karvounarakis, Tannen 2007): every
 * fact may have a tag, a rule firing combines its body facts' tags
 * into a tag for its conclusion, and a conclusion reached a second
 * time merges the new tag into the stored one. An algebra is an
 * optional argument to `evaluate`; rules never mention tags, and
 * without an algebra the evaluator never touches them.
 *
 * `merge` must return the stored tag itself when the new derivation
 * does not improve on it; any other result is stored and the fact
 * re-enters the delta. For recursive rule sets merge must be a
 * bounded meet, or evaluation will not terminate; the engine does
 * not check this. `undefined` is not a valid tag.
 */
export interface TagAlgebra<Tag> {
  /** What a fact nobody tagged contributes, i.e. every caller-asserted fact. */
  asserted: Tag;
  /** What a matched negated literal contributes: there is no fact to read. */
  absent: Tag;
  /** The head's tag from the body's, in rule-body order, once per derivation. */
  combine(bodyTags: readonly Tag[], derivation: Derivation): Tag;
  /**
   * Set when `combine` never reads `bodyTags`, and the evaluator then
   * skips looking each body fact's stored tag up. A witness is built
   * from the derivation alone, and on a large sweep the lookups were
   * three quarters of the tagged path's cost.
   */
  ignoresBodyTags?: boolean;
  /** The tag to store when a fact is derived again; see the merge contract above. */
  merge(stored: Tag, incoming: Tag): Tag;
}

/**
 * How one body literal was satisfied: the fact a positive literal
 * matched, or the grounded tuple that was not in the database when a
 * negated literal checked, kept so a proof can point at the absence.
 */
export type BodyMatch =
  | { kind: "fact"; relation: string; tuple: Tuple }
  | { kind: "absence"; relation: string; tuple: Tuple };

/**
 * One rule firing, handed to `combine` beside the body tags: the rule
 * as the caller wrote it, and one `BodyMatch` per body literal in
 * rule-body order. An algebra that only folds tags ignores it.
 */
export interface Derivation {
  rule: Rule;
  body: readonly BodyMatch[];
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

/**
 * One variable bound to one value, on top of what was bound before
 * it. A chain instead of a Map because the join extends bindings once
 * per matched fact, and copying a Map there was most of the
 * evaluator's allocation; a body binds a handful of variables, so
 * walking the chain costs less than the copies did.
 */
interface Bindings {
  readonly name: string;
  readonly value: Atom;
  readonly parent: Bindings | null;
}

function boundValue(bindings: Bindings | null, name: string): Atom | undefined {
  for (let b = bindings; b !== null; b = b.parent) {
    if (b.name === name) {
      return b.value;
    }
  }
  return undefined;
}

const NO_MATCH = Symbol("no-match");

function unify(
  literal: Literal,
  tuple: Tuple,
  bindings: Bindings | null,
): Bindings | null | typeof NO_MATCH {
  if (literal.terms.length !== tuple.length) {
    return NO_MATCH;
  }
  let next = bindings;
  for (let i = 0; i < literal.terms.length; i++) {
    const term = literal.terms[i];
    const value = tuple[i];
    if (term.type === "constant") {
      if (term.value !== value) {
        return NO_MATCH;
      }
      continue;
    }
    const bound = boundValue(next, term.name);
    if (bound === undefined) {
      next = { name: term.name, value, parent: next };
      continue;
    }
    if (bound !== value) {
      return NO_MATCH;
    }
  }
  return next;
}

/** Instantiate a negated literal's tuple; every variable must be bound. */
function groundNegated(literal: Literal, bindings: Bindings | null): Tuple {
  return literal.terms.map((term) => {
    if (term.type === "constant") {
      return term.value;
    }
    const bound = boundValue(bindings, term.name);
    if (bound === undefined) {
      throw new Error(
        `unbound variable "${term.name}" in negated literal "${literal.relation}": ` +
          "negated literals may only use variables bound by earlier positive literals",
      );
    }
    return bound;
  });
}

function headTuple(head: Rule["head"], bindings: Bindings | null): Tuple {
  return head.terms.map((term) => {
    if (term.type === "constant") {
      return term.value;
    }
    const bound = boundValue(bindings, term.name);
    if (bound === undefined) {
      throw new Error(
        `unbound variable "${term.name}" in head of "${head.relation}"`,
      );
    }
    return bound;
  });
}

const variablesOf = (literal: Literal): string[] =>
  literal.terms
    .filter((term) => term.type === "variable")
    .map((term) => (term as { name: string }).name);

/** Which body literal the round's new facts are, and the order to walk. */
interface BodyPlan {
  deltaAt: number;
  order: readonly number[];
}

const plans = new WeakMap<Rule, Map<number, BodyPlan>>();

/**
 * How to walk one rule's body. A join gives the same rows whatever order
 * it takes them in; the README says why this one is cheaper.
 */
function bodyPlan(r: Rule, deltaIndex: number): BodyPlan {
  let byDelta = plans.get(r);
  if (byDelta === undefined) {
    byDelta = new Map();
    plans.set(r, byDelta);
  }
  const known = byDelta.get(deltaIndex);
  if (known !== undefined) {
    return known;
  }
  const positives = r.body
    .map((literal, index) => (literal.negated ? -1 : index))
    .filter((index) => index !== -1);
  const deltaAt = positives[deltaIndex] ?? -1;
  const computed = { deltaAt, order: planBodyOrder(r, deltaAt) };
  byDelta.set(deltaIndex, computed);
  return computed;
}

function planBodyOrder(r: Rule, deltaAt: number): readonly number[] {
  const natural = r.body.map((_, i) => i);
  // With the delta already leading, the written order is what the rule
  // author chose and there is nothing to improve on.
  if (deltaAt <= 0) {
    return natural;
  }

  const taken = r.body.map(() => false);
  const bound = new Set<string>();
  const order: number[] = [];
  const take = (index: number): void => {
    taken[index] = true;
    order.push(index);
    for (const name of variablesOf(r.body[index])) {
      bound.add(name);
    }
  };
  const firstWhere = (want: (index: number) => boolean): number =>
    natural.find((index) => !taken[index] && want(index)) ?? -1;

  const nextLiteral = (): number => {
    // A negated literal only filters, so ask it as soon as its variables
    // are bound.
    const ready = firstWhere(
      (i) =>
        r.body[i].negated &&
        variablesOf(r.body[i]).every((name) => bound.has(name)),
    );
    if (ready !== -1) {
      return ready;
    }
    // Sharing a bound variable is what lets a literal come off an index.
    const joined = firstWhere(
      (i) =>
        !r.body[i].negated &&
        variablesOf(r.body[i]).some((name) => bound.has(name)),
    );
    if (joined !== -1) {
      return joined;
    }
    const disconnected = firstWhere((i) => !r.body[i].negated);
    if (disconnected !== -1) {
      return disconnected;
    }
    // Every literal left is negated with a variable nothing binds, which
    // is a malformed rule. Written order is where it gets reported.
    return firstWhere(() => true);
  };

  take(deltaAt);
  while (order.length < r.body.length) {
    take(nextLiteral());
  }
  return order;
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
  const { deltaAt, order } = bodyPlan(r, deltaIndex);

  const step = (orderIndex: number, bindings: Bindings | null): void => {
    if (orderIndex === order.length) {
      results.push(headTuple(r.head, bindings));
      return;
    }
    const literalIndex = order[orderIndex];
    const literal = r.body[literalIndex];

    if (literal.negated) {
      if (!db.has(literal.relation, groundNegated(literal, bindings))) {
        step(orderIndex + 1, bindings);
      }
      return;
    }

    const source =
      literalIndex === deltaAt
        ? (deltas.get(literal.relation) ?? [])
        : boundSource(db, literal, bindings);
    for (const tuple of source) {
      const next = unify(literal, tuple, bindings);
      if (next !== NO_MATCH) {
        step(orderIndex + 1, next);
      }
    }
  };

  step(0, null);
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
  bindings: Bindings | null,
): readonly Tuple[] {
  // Of the columns already fixed, the one with the fewest facts under
  // its value feeds the join the fewest candidates to reject.
  let narrowest: readonly Tuple[] | null = null;
  for (let column = 0; column < literal.terms.length; column++) {
    const term = literal.terms[column];
    const value =
      term.type === "constant" ? term.value : boundValue(bindings, term.name);
    if (value === undefined) {
      continue;
    }
    const bucket = db.lookup(literal.relation, column, value);
    if (bucket.length === 0) {
      return bucket;
    }
    if (narrowest === null || bucket.length < narrowest.length) {
      narrowest = bucket;
    }
  }
  return narrowest ?? db.facts(literal.relation);
}

/** One derived head tuple and the tag its derivation combined to. */
interface TaggedDerivation<Tag> {
  tuple: Tuple;
  tag: Tag;
}

/**
 * `evaluateRule` with tag collection. A separate walk rather than a
 * flag on the shared one, so evaluation without an algebra keeps its
 * inner loop free of per-tuple checks.
 */
const EMPTY_TAGS: readonly never[] = [];

function evaluateRuleTagged<Tag>(
  db: Database,
  deltas: Map<string, readonly Tuple[]>,
  r: Rule,
  deltaIndex: number,
  algebra: TagAlgebra<Tag>,
): TaggedDerivation<Tag>[] {
  const results: TaggedDerivation<Tag>[] = [];
  const bodyTags: Tag[] = [];
  const bodyMatches: BodyMatch[] = [];
  const readsTags = algebra.ignoresBodyTags !== true;

  const step = (
    literalIndex: number,
    positiveIndex: number,
    bindings: Bindings | null,
  ): void => {
    if (literalIndex === r.body.length) {
      results.push({
        tuple: headTuple(r.head, bindings),
        tag: algebra.combine(readsTags ? bodyTags.slice() : EMPTY_TAGS, {
          rule: r,
          body: bodyMatches.slice(),
        }),
      });
      return;
    }
    const literal = r.body[literalIndex];

    if (literal.negated) {
      const grounded = groundNegated(literal, bindings);
      if (!db.has(literal.relation, grounded)) {
        if (readsTags) {
          bodyTags.push(algebra.absent);
        }
        bodyMatches.push({
          kind: "absence",
          relation: literal.relation,
          tuple: grounded,
        });
        step(literalIndex + 1, positiveIndex, bindings);
        if (readsTags) {
          bodyTags.pop();
        }
        bodyMatches.pop();
      }
      return;
    }

    const source =
      positiveIndex === deltaIndex
        ? (deltas.get(literal.relation) ?? [])
        : boundSource(db, literal, bindings);
    for (const tuple of source) {
      const next = unify(literal, tuple, bindings);
      if (next !== NO_MATCH) {
        if (readsTags) {
          const stored = db.tagOf(literal.relation, tuple);
          bodyTags.push(
            stored === undefined ? algebra.asserted : (stored as Tag),
          );
        }
        bodyMatches.push({
          kind: "fact",
          relation: literal.relation,
          tuple,
        });
        step(literalIndex + 1, positiveIndex + 1, next);
        if (readsTags) {
          bodyTags.pop();
        }
        bodyMatches.pop();
      }
    }
  };

  step(0, 0, null);
  return results;
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
 *
 * With an `algebra`, every derivation also tags its conclusion (see
 * `TagAlgebra`). Supply the same algebra on every evaluation of a rule
 * set over a database: a resumed run derives only from the new facts,
 * so it tags only what those reach.
 */
export function evaluate<Tag = never>(
  db: Database,
  rules: Rule[],
  algebra?: TagAlgebra<Tag>,
): Database {
  if (algebra !== undefined && isDemandRewritten(rules)) {
    throw new Error(
      "cannot evaluate demand-rewritten rules with a tag algebra: tags would " +
        "follow the demand-transformed rules rather than the ones the caller wrote",
    );
  }
  deriving.set(db, (deriving.get(db) ?? 0) + 1);
  try {
    return runRules(db, rules, algebra);
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

/**
 * Whether a rule can produce anything at all right now. A join reads every
 * positive literal, so one of them being empty means there is nothing to
 * find, and a rule set has rules for shapes a given project never writes.
 * A relation that fills up later gets the rule run in a later round.
 */
function couldProduce(db: Database, rule: Rule): boolean {
  return rule.body.every(
    (literal) => literal.negated || db.size(literal.relation) > 0,
  );
}

/**
 * `add`'s merge callback for one algebra. An untagged fact reads as
 * `asserted`, so a merge that lands back on `asserted` for a fact with
 * no stored tag returns the stored undefined: nothing is written, and
 * nothing re-enters the delta for a round that would change nothing.
 */
function storedMergeFor<Tag>(
  algebra: TagAlgebra<Tag>,
): (stored: unknown, incoming: unknown) => unknown {
  return (stored, incoming) => {
    const merged = algebra.merge(
      (stored === undefined ? algebra.asserted : stored) as Tag,
      incoming as Tag,
    );
    return stored === undefined && merged === algebra.asserted
      ? undefined
      : merged;
  };
}

function runRules<Tag>(
  db: Database,
  rules: Rule[],
  algebra?: TagAlgebra<Tag>,
): Database {
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
  const noteDerived = (relation: string, tuple: Tuple): void => {
    let ledger = derived.get(relation);
    if (ledger === undefined) {
      ledger = new Map();
      derived.set(relation, ledger);
    }
    ledger.set(keyOf(tuple), tuple);
  };
  const mergeStored =
    algebra === undefined ? undefined : storedMergeFor(algebra);
  // Taken before any stratum runs, so a later stratum's seed picks up
  // what the strata below it just derived.
  const marks = canResume(rules, state) ? state.marks : undefined;

  for (const stratum of strata) {
    let delta = new Map<string, Tuple[]>();
    const derivedHere = new Set(stratum.map((r) => r.head.relation));

    const record = (relation: string, tuple: Tuple): void => {
      if (db.add(relation, tuple) === "added") {
        addTo(delta, relation, tuple);
        noteDerived(relation, tuple);
      }
    };

    // An improved tag re-enters the delta so downstream conclusions
    // recompute with it, but the fact itself is already owned, so only
    // "added" goes in the ledger.
    const recordTagged =
      mergeStored === undefined
        ? undefined
        : (relation: string, tuple: Tuple, tag: unknown): void => {
            const outcome = db.add(relation, tuple, tag, mergeStored);
            if (outcome === "unchanged") {
              return;
            }
            addTo(delta, relation, tuple);
            if (outcome === "added") {
              noteDerived(relation, tuple);
            }
          };

    const deriveInto = (
      r: Rule,
      seed: Map<string, readonly Tuple[]>,
      deltaIndex: number,
    ): void => {
      if (algebra !== undefined && recordTagged !== undefined) {
        for (const found of evaluateRuleTagged(
          db,
          seed,
          r,
          deltaIndex,
          algebra,
        )) {
          recordTagged(r.head.relation, found.tuple, found.tag);
        }
        return;
      }
      for (const tuple of evaluateRule(db, seed, r, deltaIndex)) {
        record(r.head.relation, tuple);
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
        deriveInto(r, seed, deltaIndex);
        return;
      }
      const startedAt = performance.now();
      const before = db.size(r.head.relation);
      deriveInto(r, seed, deltaIndex);
      chargeRule(
        ruleSetName,
        r.head.relation,
        r.body.map(literalName),
        performance.now() - startedAt,
        db.size(r.head.relation) - before,
      );
    };

    const applyDelta = (
      seed: Map<string, readonly Tuple[]>,
      derivedOnly: boolean,
    ): void => {
      for (const r of stratum) {
        if (!couldProduce(db, r)) {
          continue;
        }
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
        if (!couldProduce(db, r)) {
          continue;
        }
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
