/**
 * Which rules of a stratum a semi-naive round runs. A round joins each
 * rule once per positive literal that has facts new since the last round,
 * so a rule none of whose positive literals has any reads nothing and
 * derives nothing. A rule set can have hundreds of rules while a round's
 * new facts sit in a few relations, so each stratum lists, per relation,
 * the rules that read it, and a round looks its rules up there instead of
 * checking every rule in the stratum.
 *
 * The rules come back in the order they were written, which is the order
 * a round that checked every rule ran them in. The rows a round reads and
 * the facts it derives stay the same.
 */

import type { Rule, Tuple } from "./index.js";

/** One stratum of a rule set, with what its rounds look up worked out once. */
export interface Stratum {
  rules: readonly Rule[];
  /** The relations this stratum's rules derive. */
  derived: ReadonlySet<string>;
  /**
   * Per relation, the positions in `rules` of the rules that read it in
   * a positive literal, ascending and each listed once.
   */
  readers: ReadonlyMap<string, readonly number[]>;
  /**
   * One flag per rule, which `rulesReading` sets and clears again before
   * it returns. A round's rules come to a few dozen out of hundreds, and
   * marking them costs less than sorting them.
   */
  marked: Uint8Array;
}

export function planStratum(rules: readonly Rule[]): Stratum {
  const derived = new Set<string>();
  const readers = new Map<string, number[]>();
  for (let at = 0; at < rules.length; at++) {
    const r = rules[at];
    derived.add(r.head.relation);
    for (const literal of r.body) {
      if (literal.negated) {
        continue;
      }
      const positions = readers.get(literal.relation);
      if (positions === undefined) {
        readers.set(literal.relation, [at]);
        continue;
      }
      if (positions[positions.length - 1] !== at) {
        positions.push(at);
      }
    }
  }
  return { rules, derived, readers, marked: new Uint8Array(rules.length) };
}

const NONE: readonly number[] = [];

/**
 * The positions of the rules that read a relation with facts in `seed`,
 * ascending. With `derivedOnly`, a relation this stratum does not derive
 * does not count: within one evaluation the facts below it stay put.
 */
export function rulesReading(
  stratum: Stratum,
  seed: ReadonlyMap<string, readonly Tuple[]>,
  derivedOnly: boolean,
): readonly number[] {
  const lists: (readonly number[])[] = [];
  for (const [relation, tuples] of seed) {
    if (tuples.length === 0) {
      continue;
    }
    if (derivedOnly && !stratum.derived.has(relation)) {
      continue;
    }
    const positions = stratum.readers.get(relation);
    if (positions !== undefined) {
      lists.push(positions);
    }
  }
  if (lists.length === 0) {
    return NONE;
  }
  if (lists.length === 1) {
    return lists[0];
  }
  return unionInOrder(lists, stratum.marked);
}

/** The positions in any of `lists`, ascending and each once. */
function unionInOrder(
  lists: readonly (readonly number[])[],
  marked: Uint8Array,
): number[] {
  let first = marked.length;
  let last = -1;
  for (const positions of lists) {
    for (const at of positions) {
      marked[at] = 1;
    }
    first = Math.min(first, positions[0]);
    last = Math.max(last, positions[positions.length - 1]);
  }
  const union: number[] = [];
  for (let at = first; at <= last; at++) {
    if (marked[at] === 1) {
      marked[at] = 0;
      union.push(at);
    }
  }
  return union;
}
