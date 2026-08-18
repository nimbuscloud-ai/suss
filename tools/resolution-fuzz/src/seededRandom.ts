/**
 * The random source the generated fact bases draw from.
 *
 * `Math.random` is not usable here. A committed answer is only worth
 * comparing against if the fact base that produced it can be produced
 * again on another machine later, so the arithmetic lives here and the
 * seed goes in the snapshot. The algorithm is mulberry32; the bar is
 * that consecutive draws look unrelated, not anything cryptographic.
 */

export interface Random {
  /** A whole number in [0, bound). */
  readonly below: (bound: number) => number;
  /** True with probability p. */
  readonly chance: (p: number) => boolean;
  /** One item, uniformly. */
  readonly pick: <T>(items: readonly T[]) => T;
  /**
   * One item, weighted toward the end of the list. Pools are kept in the
   * order things were made, so this is what makes a generated program a
   * chain instead of a heap of unrelated pairs.
   */
  readonly pickRecent: <T>(items: readonly T[]) => T;
}

const seedFrom = (seed: number, stream: number): number =>
  (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^
    Math.imul(stream + 1, 0xc2b2ae35)) >>>
  0;

const itemAt = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) {
    throw new Error("picked from an empty pool");
  }
  return item;
};

/**
 * A source seeded by a run seed and a stream number. Base 37 draws from
 * stream 37, so it produces the same facts whether the run asked for
 * forty bases or four thousand, and reproducing it costs one base
 * rather than the thirty-seven up to it.
 */
export function seededRandom(seed: number, stream = 0): Random {
  let state = seedFrom(seed, stream);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const below = (bound: number): number => Math.floor(next() * bound);

  const pickRecent = <T>(items: readonly T[]): T => {
    // Each step back is half as likely as the one in front of it.
    let index = items.length - 1;
    while (index > 0 && next() < 0.45) {
      index -= 1;
    }
    return itemAt(items, index);
  };

  return {
    below,
    chance: (p) => next() < p,
    pick: (items) => itemAt(items, below(items.length)),
    pickRecent,
  };
}
