/**
 * What an evaluation looked up, so a caller that cached its answer can
 * tell later whether a fact that arrived since could change it.
 *
 * While `noteReads` runs, every lookup the join makes is noted as the
 * relation, the column and the value, and a relation read whole is
 * noted whole. At the end each lookup's facts are counted. The cached
 * answer is still right when every count is the same and nothing was
 * retracted from those relations. Without a retraction counts only
 * grow, so the sum of the counts changes exactly when one of them does.
 * DESIGN.md explains why a fact no lookup would find cannot change the
 * answer, and what that asks of the rules.
 */

import { bucketSize, type Relation } from "./relation.js";

import type { Atom, Database } from "./index.js";

/** @internal One relation's reads: the values looked up per column, unless something read it whole. */
export interface RelationReads {
  whole: boolean;
  columns: (Set<Atom> | undefined)[];
}

/** @internal Note one lookup in a relation's reads. */
export function noteIn(
  reads: RelationReads,
  column: number,
  value: Atom,
): void {
  if (reads.whole) {
    return;
  }
  let values = reads.columns[column];
  if (values === undefined) {
    values = new Set();
    reads.columns[column] = values;
  }
  values.add(value);
}

/** @internal The join notes its reads here while `noteReads` runs. */
export class ReadLog {
  /** Null for a relation the caller said to leave out. */
  private readonly byRelation = new Map<string, RelationReads | null>();

  constructor(private readonly skipped: ReadonlySet<string>) {}

  lookedUp(relation: string, column: number, value: Atom): void {
    const reads = this.readsOf(relation);
    if (reads !== null) {
      noteIn(reads, column, value);
    }
  }

  readWhole(relation: string): void {
    const reads = this.readsOf(relation);
    if (reads !== null) {
      reads.whole = true;
    }
  }

  /** Note everything an inner log noted, for an answer cached inside another. */
  absorb(inner: ReadLog): void {
    for (const [relation, reads] of inner.byRelation) {
      if (reads === null) {
        continue;
      }
      if (reads.whole) {
        this.readWhole(relation);
        continue;
      }
      reads.columns.forEach((values, column) => {
        for (const value of values ?? []) {
          this.lookedUp(relation, column, value);
        }
      });
    }
  }

  /**
   * The reads with what each one finds in `db` now. One question looks
   * up the same values in many columns, so each value is kept once, and
   * each column keeps a bit per value saying whether it was looked up
   * there.
   */
  counted(db: Database): ReadsNoted {
    const names: string[] = [];
    const groups: number[] = [];
    const columns: number[] = [];
    const lookedUp: ReadonlySet<Atom>[] = [];
    const positions = new Map<Atom, number>();
    const values: Atom[] = [];
    const addGroup = (column: number, seen: ReadonlySet<Atom>): void => {
      groups.push(names.length - 1);
      columns.push(column);
      lookedUp.push(seen);
      for (const value of seen) {
        if (!positions.has(value)) {
          positions.set(value, values.length);
          values.push(value);
        }
      }
    };
    for (const [relation, reads] of this.byRelation) {
      if (reads === null) {
        continue;
      }
      names.push(relation);
      if (reads.whole) {
        addGroup(WHOLE, NONE);
        continue;
      }
      reads.columns.forEach((seen, column) => {
        if (seen !== undefined) {
          addGroup(column, seen);
        }
      });
    }
    const words = Math.ceil(values.length / 32);
    const bits = new Uint32Array(groups.length * words);
    let found = 0;
    lookedUp.forEach((seen, group) => {
      const relation = db.relationOf(names[groups[group] as number] as string);
      const column = columns[group] as number;
      if (column === WHOLE) {
        found += relation?.tuples.length ?? 0;
      }
      for (const value of seen) {
        const at = positions.get(value) as number;
        bits[group * words + (at >>> 5)] |= 1 << (at & 31);
        found +=
          relation === undefined ? 0 : bucketSize(relation, column, value);
      }
    });
    return new ReadsNoted(
      db,
      this.skipped,
      { names, groups, columns, values, bits },
      found,
    );
  }

  /** @internal Null for a relation the caller said to leave out. */
  readsOf(relation: string): RelationReads | null {
    let reads = this.byRelation.get(relation);
    if (reads === undefined) {
      reads = this.skipped.has(relation) ? null : { whole: false, columns: [] };
      this.byRelation.set(relation, reads);
    }
    return reads;
  }
}

/** The column `ReadsNoted` lists for a relation read whole. */
const WHOLE = -1;

const NONE: ReadonlySet<Atom> = new Set();

/**
 * Group `g` is the column `columns[g]` of the relation at
 * `names[groups[g]]`. Its bits start at word `g` times the words one
 * group takes, and bit `i` says it looked up `values[i]`.
 */
interface Lookups {
  names: readonly string[];
  groups: readonly number[];
  columns: readonly number[];
  values: readonly Atom[];
  bits: Uint32Array;
}

/**
 * The lookups one evaluation made, and how many facts they found when
 * it finished. The values are the atoms the facts already contain, so
 * a value costs a reference, and each column it was looked up in costs
 * a bit.
 */
export class ReadsNoted {
  private readonly names: readonly string[];
  private readonly groups: readonly number[];
  private readonly columns: readonly number[];
  private readonly values: readonly Atom[];
  private readonly bits: Uint32Array;
  private readonly words: number;
  private readonly removed: number;
  /** The facts in every relation read, when the counts last matched. */
  private facts: number;
  /** Each relation read, found by name the first time a check needs it. */
  private readonly relations: (Relation | undefined)[];

  constructor(
    db: Database,
    private readonly skipped: ReadonlySet<string>,
    lookups: Lookups,
    private readonly found: number,
  ) {
    this.names = lookups.names;
    this.groups = lookups.groups;
    this.columns = lookups.columns;
    this.values = lookups.values;
    this.bits = lookups.bits;
    this.words = Math.ceil(lookups.values.length / 32);
    this.relations = lookups.names.map((name) => db.relationOf(name));
    this.removed = this.sumOver(db, removedFrom);
    this.facts = this.sumOver(db, factsIn);
  }

  /**
   * Whether every read would find what it found then. A fact left in a
   * skipped relation would join a question asked now without anything
   * here having looked it up, so one there makes the answer no. The
   * counts are taken again only when a relation read has grown.
   */
  unchangedIn(db: Database): boolean {
    if (!allEmpty(db, this.skipped)) {
      return false;
    }
    if (this.sumOver(db, removedFrom) !== this.removed) {
      return false;
    }
    const facts = this.sumOver(db, factsIn);
    if (facts === this.facts) {
      return true;
    }
    if (this.countIn(db, this.found) !== this.found) {
      return false;
    }
    this.facts = facts;
    return true;
  }

  private relationAt(db: Database, at: number): Relation | undefined {
    let relation = this.relations[at];
    if (relation === undefined) {
      relation = db.relationOf(this.names[at] as string);
      this.relations[at] = relation;
    }
    return relation;
  }

  private sumOver(db: Database, measure: (r: Relation) => number): number {
    let sum = 0;
    for (let at = 0; at < this.names.length; at++) {
      const relation = this.relationAt(db, at);
      sum += relation === undefined ? 0 : measure(relation);
    }
    return sum;
  }

  /**
   * The facts the reads find, stopping once past `limit`. With nothing
   * retracted every count only grows, so passing the old total already
   * says that one of them grew.
   */
  private countIn(db: Database, limit: number): number {
    let found = 0;
    for (let group = 0; group < this.groups.length && found <= limit; group++) {
      const relation = this.relationAt(db, this.groups[group] as number);
      const column = this.columns[group] as number;
      if (column === WHOLE) {
        found += relation?.tuples.length ?? 0;
      } else if (relation !== undefined) {
        found += this.countGroup(relation, group, column);
      }
    }
    return found;
  }

  private countGroup(
    relation: Relation,
    group: number,
    column: number,
  ): number {
    let found = 0;
    const first = group * this.words;
    for (let word = 0; word < this.words; word++) {
      let left = this.bits[first + word] as number;
      while (left !== 0) {
        const bit = 31 - Math.clz32(left & -left);
        left &= left - 1;
        const value = this.values[word * 32 + bit] as Atom;
        found += bucketSize(relation, column, value);
      }
    }
    return found;
  }
}

const removedFrom = (relation: Relation): number => relation.removed;

const factsIn = (relation: Relation): number => relation.tuples.length;

/** The skipped relations that exist, kept per set so a check doesn't look each one up by name. */
interface SkippedRelations {
  found: Relation[];
  missing: string[];
}

const skippedIn = new WeakMap<
  Database,
  WeakMap<ReadonlySet<string>, SkippedRelations>
>();

function allEmpty(db: Database, skipped: ReadonlySet<string>): boolean {
  let bySet = skippedIn.get(db);
  if (bySet === undefined) {
    bySet = new WeakMap();
    skippedIn.set(db, bySet);
  }
  let known = bySet.get(skipped);
  if (known === undefined) {
    known = { found: [], missing: [...skipped] };
    bySet.set(skipped, known);
  }
  if (known.missing.length > 0) {
    const stillMissing: string[] = [];
    for (const name of known.missing) {
      const relation = db.relationOf(name);
      if (relation === undefined) {
        stillMissing.push(name);
      } else {
        known.found.push(relation);
      }
    }
    known.missing = stillMissing;
  }
  return known.found.every((relation) => relation.tuples.length === 0);
}

/**
 * Run `work` and note what the join and the database's readers look up
 * in every relation outside `skipped`. A caller skips the
 * relations it empties after every question, so that the work derives
 * their facts again and the lookups behind them get noted. The reads
 * are null when a skipped relation was not empty to begin with, since
 * the work could then build on facts nothing here looked up.
 */
export function noteReads<T>(
  db: Database,
  skipped: ReadonlySet<string>,
  work: () => T,
): { value: T; reads: ReadsNoted | null } {
  const outer = db.readLog;
  const log = new ReadLog(skipped);
  const emptyAtStart = allEmpty(db, skipped);
  db.readLog = log;
  try {
    const value = work();
    return { value, reads: emptyAtStart ? log.counted(db) : null };
  } finally {
    db.readLog = outer;
    outer?.absorb(log);
  }
}
