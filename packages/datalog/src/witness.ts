/**
 * Witnesses: one derivation kept per derived fact, and proofs rebuilt
 * on demand by walking those derivations backward.
 *
 * Evaluate under the `witnesses` algebra and every derived fact stores
 * a `Witness`: the rule that fired and one entry per body literal. The
 * merge keeps whatever is already stored, so a fact derived nine ways
 * keeps its first witness and the fixpoint behaves exactly as it does
 * untagged. First-wins means a proof, not the shortest proof; the
 * algebra interface already allows a different merge. `proofOf` walks
 * the stored witnesses into a tree when somebody asks, the way
 * Soufflé's provenance mode does, and never re-runs a rule.
 */

import { tupleKey } from "./tupleKey.js";

import type {
  BodyMatch,
  Database,
  Derivation,
  Rule,
  TagAlgebra,
  Tuple,
} from "./index.js";

/**
 * The tag the `witnesses` algebra stores on a derived fact. A class,
 * so `proofOf` can tell a witness from another algebra's tag by
 * `instanceof` and treat anything else as an untagged leaf.
 */
export class Witness {
  constructor(
    readonly rule: Rule,
    readonly body: readonly BodyMatch[],
  ) {}
}

/**
 * What a fact's tag can be under `witnesses`. The marks stand in for a
 * caller-asserted fact and a matched negation inside the algebra;
 * neither is ever stored, so `tagOf` only ever returns a `Witness`.
 */
export type WitnessTag = Witness | "asserted" | "absent";

/**
 * The algebra that keeps one witness per derived fact. Merge returns
 * the stored tag, so no fact ever re-enters the delta and evaluation
 * costs only the bookkeeping.
 */
export const witnesses: TagAlgebra<WitnessTag> = {
  asserted: "asserted",
  absent: "absent",
  // A witness is built from the derivation alone, and saying so lets
  // the evaluator skip the body-tag lookups, which were most of the
  // tagged path's cost on a large sweep.
  ignoresBodyTags: true,
  combine: (_bodyTags, derivation: Derivation) =>
    new Witness(derivation.rule, derivation.body),
  merge: (stored) => stored,
};

/** A reconstructed derivation tree for one fact. */
export type Proof =
  | ProofDerived
  | { kind: "fact"; relation: string; tuple: Tuple }
  | { kind: "absence"; relation: string; tuple: Tuple }
  | {
      kind: "truncated";
      relation: string;
      tuple: Tuple;
      reason: "depth" | "cycle";
    };

export interface ProofDerived {
  kind: "derived";
  relation: string;
  tuple: Tuple;
  rule: Rule;
  /** One proof per body literal, in rule-body order. */
  premises: readonly Proof[];
}

export interface ProofOptions {
  /** How many derived nodes deep the walk goes before truncating. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 128;

/**
 * Rebuild the proof of one fact from stored witnesses, without
 * re-running any evaluation. A `fact` leaf has no witness: the caller
 * asserted it, or it was derived without the `witnesses` algebra. An
 * `absence` leaf is a tuple missing from the database, at the root
 * when the asked-about fact was never derived, and under a derivation
 * where a negated literal relied on it being missing, reported as
 * evaluation saw it rather than re-checked now. `truncated` is where
 * the depth cap or the cycle guard stopped the walk.
 */
export function proofOf(
  db: Database,
  relation: string,
  tuple: Tuple,
  options: ProofOptions = {},
): Proof {
  return walk(
    db,
    relation,
    tuple,
    options.maxDepth ?? DEFAULT_MAX_DEPTH,
    new Set(),
  );
}

const premiseOf: Record<
  BodyMatch["kind"],
  (db: Database, match: BodyMatch, depth: number, path: Set<string>) => Proof
> = {
  fact: (db, match, depth, path) =>
    walk(db, match.relation, match.tuple, depth, path),
  absence: (_db, match) => ({
    kind: "absence",
    relation: match.relation,
    tuple: match.tuple,
  }),
};

function walk(
  db: Database,
  relation: string,
  tuple: Tuple,
  depth: number,
  path: Set<string>,
): Proof {
  if (!db.has(relation, tuple)) {
    return { kind: "absence", relation, tuple };
  }
  const tag = db.tagOf(relation, tuple);
  if (!(tag instanceof Witness)) {
    return { kind: "fact", relation, tuple };
  }
  if (depth <= 0) {
    return { kind: "truncated", relation, tuple, reason: "depth" };
  }
  // A stored witness only ever points at facts that were already in the
  // database, so evaluation cannot build a cycle; a caller storing tags
  // by hand can, so the guard stays.
  const key = tupleKey([relation, ...tuple]);
  if (path.has(key)) {
    return { kind: "truncated", relation, tuple, reason: "cycle" };
  }
  path.add(key);
  const premises = tag.body.map((match) =>
    premiseOf[match.kind](db, match, depth - 1, path),
  );
  path.delete(key);
  return { kind: "derived", relation, tuple, rule: tag.rule, premises };
}
