/**
 * What each piece of an adapter's work depended on, so a cache can tell
 * which pieces a later run may reuse.
 *
 * An adapter runs each piece of work, one file's discovery or one
 * function's scan, inside `charging`. Every question the work puts to the
 * rules is charged to it as the values the question demanded, derived or
 * answered. A question asked a second time is answered from the database,
 * so what it touched the first time is kept per key and charged again.
 * Syntax read straight out of another file is charged as that file, and a
 * lookup in an index built over every file is charged with what it gave
 * back. `FactLog` then says whose facts changed between two runs.
 */

import { ANSWER_RELATIONS } from "./index.js";

import type { Database, Tuple } from "@suss/datalog";

/** What one piece of work depended on. */
export interface Dependencies {
  /** Files whose syntax the work read directly. */
  readonly files: Set<string>;
  /** Values the rules asked about, derived or answered for the work, and keys it placed on a summary. */
  readonly values: Set<string>;
  /** Lookups in indexes built over every file, by what was looked up, with a hash of what came back. */
  readonly checks: Map<string, number>;
}

export function noDependencies(): Dependencies {
  return { files: new Set(), values: new Set(), checks: new Map() };
}

const NO_VALUES: ReadonlySet<string> = new Set();

export class DependencyLedger {
  private readonly files: ReadonlySet<string>;
  private readonly fileByValue = new Map<string, string | null>();
  private readonly valuesByAsked = new Map<string, ReadonlySet<string>>();
  private readonly active: Dependencies[] = [];

  constructor(files: Iterable<string>) {
    this.files = new Set(files);
  }

  /** The file a key starts with, or is, or null for a value that is neither. */
  fileOf(value: string): string | null {
    const known = this.fileByValue.get(value);
    if (known !== undefined) {
      return known;
    }
    const file = this.findFile(value);
    this.fileByValue.set(value, file);
    return file;
  }

  private findFile(value: string): string | null {
    if (this.files.has(value)) {
      return value;
    }
    for (let at = 0; at < value.length; at++) {
      const char = value.charCodeAt(at);
      // A key puts `:` or `#` straight after the file path.
      if (char !== 58 && char !== 35) {
        continue;
      }
      const prefix = value.slice(0, at);
      if (this.files.has(prefix)) {
        return prefix;
      }
    }
    return null;
  }

  /** Run `work`, charging everything it asks and reads to `into`. */
  charging<T>(into: Dependencies, work: () => T): T {
    this.active.push(into);
    try {
      return work();
    } finally {
      this.active.pop();
    }
  }

  /** `charging` for work that awaits. Nothing else may run until it settles. */
  async chargingAsync<T>(
    into: Dependencies,
    work: () => Promise<T>,
  ): Promise<T> {
    this.active.push(into);
    try {
      return await work();
    } finally {
      this.active.pop();
    }
  }

  private readonly hashByValue = new Map<string, number>();

  /** Dependencies as a cache stores them. The same values come up in many charges, so each is hashed once. */
  store(dependencies: Dependencies): StoredDependencies {
    const hash = (value: string): number => {
      let known = this.hashByValue.get(value);
      if (known === undefined) {
        known = hashString(value);
        this.hashByValue.set(value, known);
      }
      return known;
    };
    return {
      files: packHashes([...dependencies.files].map(hash)),
      values: packHashes([...dependencies.values].map(hash)),
      checks: [...dependencies.checks],
    };
  }

  /** Charge a file whose syntax the work read directly. */
  readFile(file: string): void {
    for (const charge of this.active) {
      charge.files.add(file);
    }
  }

  /** Charge the file of a node the work read the syntax of. */
  readKey(key: string): void {
    const file = this.fileOf(key);
    if (file !== null) {
      this.readFile(file);
    }
  }

  /** Charge a key whose facts the work's result depends on without asking about it, such as a callee whose span goes on a summary. */
  touchKey(key: string): void {
    for (const charge of this.active) {
      charge.values.add(key);
    }
  }

  /**
   * Charge a lookup in an index built over every file, such as methods by
   * name. `id` has to be enough for a later run to look again, and `found`
   * describes what came back.
   */
  looked(id: string, found: string): void {
    if (this.active.length === 0) {
      return;
    }
    const digest = hashString(found);
    for (const charge of this.active) {
      charge.checks.set(id, digest);
    }
  }

  /**
   * The keys one evaluation asked about for the first time, and every
   * value the rules asked about or derived on the way to the answer.
   */
  evaluated(
    asking: string,
    keys: readonly string[],
    values: ReadonlySet<string>,
  ): void {
    // Only a key's facts are compared between runs, so names are dropped.
    const touched = new Set<string>();
    for (const value of values) {
      if (this.fileOf(value) !== null) {
        touched.add(value);
      }
    }
    for (const key of keys) {
      this.valuesByAsked.set(`${asking} ${key}`, touched);
    }
    this.chargeValues(touched);
  }

  /** Keys asked about again, whose answers are already in the database. */
  reasked(asking: string, keys: readonly string[]): void {
    if (this.active.length === 0) {
      return;
    }
    for (const key of keys) {
      this.chargeValues(
        this.valuesByAsked.get(`${asking} ${key}`) ?? NO_VALUES,
      );
    }
  }

  private chargeValues(values: ReadonlySet<string>): void {
    for (const charge of this.active) {
      for (const value of values) {
        charge.values.add(value);
      }
    }
  }
}

/**
 * A map built over every file whose lookups report what was looked up
 * and what came back, so work that reads it by name is charged for it.
 */
export class WatchedMap<K, V> extends Map<K, V> {
  constructor(
    entries: Iterable<readonly [K, V]>,
    private readonly seen: (key: K, value: V | undefined) => void,
  ) {
    super(entries);
  }

  override get(key: K): V | undefined {
    const value = super.get(key);
    this.seen(key, value);
    return value;
  }

  override has(key: K): boolean {
    return this.get(key) !== undefined;
  }
}

/** A 32-bit FNV-1a hash, for storing many strings compactly where a collision only costs a re-read. */
export function hashString(text: string): number {
  return fnv(0x811c9dc5, text) >>> 0;
}

function fnv(start: number, text: string): number {
  let hash = start;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

/** Hashes as one string of eight hex digits each, which JSON stores in less space than a list of numbers. */
export function packHashes(hashes: Iterable<number>): string {
  let packed = "";
  for (const hash of hashes) {
    packed += hash.toString(16).padStart(8, "0");
  }
  return packed;
}

export function unpackHashes(packed: string): number[] {
  const hashes: number[] = [];
  for (let at = 0; at + 8 <= packed.length; at += 8) {
    hashes.push(Number.parseInt(packed.slice(at, at + 8), 16));
  }
  return hashes;
}

/** Dependencies as a cache stores them: files and values by hash, lookups by id. */
export interface StoredDependencies {
  readonly files: string;
  readonly values: string;
  readonly checks: readonly (readonly [string, number])[];
}

/** One stored record for work that was partly reused and partly done again. */
export function mergeStoredDependencies(
  one: StoredDependencies,
  other: StoredDependencies,
): StoredDependencies {
  const union = (a: string, b: string): string =>
    packHashes(new Set([...unpackHashes(a), ...unpackHashes(b)]));
  return {
    files: union(one.files, other.files),
    values: union(one.values, other.values),
    checks: [...new Map([...one.checks, ...other.checks])],
  };
}

/** What changed between the run that stored some dependencies and this one. */
export interface Changes {
  /** Hashes of the files whose content changed. */
  readonly files: ReadonlySet<number>;
  /** Hashes of the values whose facts changed. */
  readonly values: ReadonlySet<number>;
  /** The lookup stored under `id`, made again in this run, or null when this run cannot make it. */
  lookAgain(id: string): string | null;
}

/**
 * Whether stored dependencies still describe this run: none of their
 * files changed, no fact about any of their values changed, and every
 * lookup comes back the same.
 */
export function stillValid(
  stored: StoredDependencies,
  changes: Changes,
): boolean {
  for (const hash of unpackHashes(stored.files)) {
    if (changes.files.has(hash)) {
      return false;
    }
  }
  if (changes.values.size > 0) {
    for (const hash of unpackHashes(stored.values)) {
      if (changes.values.has(hash)) {
        return false;
      }
    }
  }
  return stored.checks.every(([id, digest]) => {
    const found = changes.lookAgain(id);
    return found !== null && hashString(found) === digest;
  });
}

/** What one file's facts were, stored so a later run can tell whose facts changed. */
export interface StoredFacts {
  /** For each value in the rows this file emitted on its own, its hash followed by a hash of those rows. */
  readonly own: string;
  /** For each key of this file in a row that joins files, its hash followed by a hash of those rows. */
  readonly joined: string;
}

type Marks = ReadonlyMap<string, number>;

function rowMarks(db: Database): Map<string, number> {
  return new Map(
    db.relationNames().map((relation) => [relation, db.size(relation)]),
  );
}

/** The node span right after a key's file path, as in `file:12-40` or `file:12-40#name`. */
const SPAN_AT_START = /^:\d+-\d+/;

/** An atom's hashes, worked out once per run. */
interface AtomHashes {
  /** Whether the atom is a key, which gets a digest of its own. */
  readonly key: boolean;
  readonly exact: number;
  /** The same, with a node key's offsets left out. */
  readonly loose: number;
}

/** Spreads a row's hash before it is summed into a digest, so two rows' hashes do not cancel. */
function spread(hash: number): number {
  let mixed = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

/** Hashes of rows added into one digest per value, in any order. */
class Digests {
  readonly sums = new Map<string, number>();
  readonly counts = new Map<string, number>();

  add(value: string, rowHash: number): void {
    this.sums.set(value, ((this.sums.get(value) ?? 0) + spread(rowHash)) >>> 0);
    this.counts.set(value, (this.counts.get(value) ?? 0) + 1);
  }

  digestOf(value: string): number {
    return spread(
      ((this.sums.get(value) ?? 0) ^
        Math.imul(this.counts.get(value) ?? 0, 0x9e3779b1)) >>>
        0,
    );
  }

  /** Each value's hash followed by its digest. */
  pairs(values: Iterable<string>): number[] {
    const pairs: number[] = [];
    for (const value of values) {
      pairs.push(hashString(value), this.digestOf(value));
    }
    return pairs;
  }
}

function pairsOf(packed: string): Map<number, number> {
  const numbers = unpackHashes(packed);
  const pairs = new Map<number, number>();
  for (let at = 0; at + 1 < numbers.length; at += 2) {
    pairs.set(numbers[at] as number, numbers[at + 1] as number);
  }
  return pairs;
}

/** Every value whose digest differs between a stored set of pairs and a fresh one, or is only in one. */
function differing(
  stored: Map<number, number>,
  fresh: Map<number, number>,
  into: Set<number>,
): void {
  for (const [hash, digest] of fresh) {
    if (stored.get(hash) !== digest) {
      into.add(hash);
    }
  }
  for (const hash of stored.keys()) {
    if (!fresh.has(hash)) {
      into.add(hash);
    }
  }
}

/**
 * The rows a run emitted file by file, and the rows that join files,
 * which an adapter adds once every file is in. A cache stores a digest of
 * the rows each key appears in, and the next run compares. A key whose
 * rows changed is one whose facts changed. That includes a key in a file
 * nobody edited, such as a constant reference that a definition in a new
 * place now binds instead. Names are left out: every way one file reaches
 * into another goes through a key, and a name like `params` is in the
 * rows of nearly every file.
 */
export class FactLog {
  private readonly ranges = new Map<string, [Marks, Marks]>();
  private readonly joinedRanges: [Marks, Marks][] = [];
  private opened: Marks = new Map();

  constructor(
    private readonly db: Database,
    private readonly ledger: DependencyLedger,
  ) {}

  /** Call before a file emits its own rows. */
  startFile(): void {
    this.opened = rowMarks(this.db);
  }

  /** Call after the file emitted its own rows. */
  endFile(file: string): void {
    this.ranges.set(file, [this.opened, rowMarks(this.db)]);
  }

  /** Call before rows that join files are added. There may be several such stretches. */
  startJoined(): void {
    this.opened = rowMarks(this.db);
  }

  endJoined(): void {
    this.joinedRanges.push([this.opened, rowMarks(this.db)]);
  }

  private fileOf(atom: string): string | null {
    return this.ledger.fileOf(atom);
  }

  /** Every row added in a stretch, skipping the answers a question adds, which are not facts. */
  private *rowsIn(from: Marks, to: Marks): Generator<[string, Tuple]> {
    const answers = new Set<string>(ANSWER_RELATIONS);
    for (const [relation, end] of to) {
      if (answers.has(relation)) {
        continue;
      }
      const rows = this.db.facts(relation);
      for (
        let at = from.get(relation) ?? 0;
        at < end && at < rows.length;
        at++
      ) {
        yield [relation, rows[at] as Tuple];
      }
    }
  }

  private readonly atomHashes = new Map<string, AtomHashes>();

  /**
   * An atom's hash as written, and with its node offsets left out, so a
   * row that mentions a key next to another hashes the same after an edit
   * shifts the other. Work that used the other key has it among its own
   * values, and is checked on it.
   */
  private hashesOf(atom: string): AtomHashes {
    let known = this.atomHashes.get(atom);
    if (known !== undefined) {
      return known;
    }
    const file = this.fileOf(atom);
    const exact = hashString(atom);
    const span =
      file === null ? null : SPAN_AT_START.exec(atom.slice(file.length));
    known = {
      key: file !== null,
      exact,
      loose:
        file === null || span === null
          ? exact
          : hashString(`${file}:*${atom.slice(file.length + span[0].length)}`),
    };
    this.atomHashes.set(atom, known);
    return known;
  }

  /** Each key in a row, with a hash of the row as seen from that key: the key as written, every other key loose. */
  private hashesByKey(relation: string, row: Tuple): Map<string, number> {
    const hashes = new Map<string, number>();
    const atoms = row.map((atom) => this.hashesOf(String(atom)));
    // Each column adds its own term, so swapping one key's loose term for
    // its exact one gives the row as seen from that key.
    const term = (hash: number, column: number): number =>
      spread((hash + Math.imul(column + 1, 0x9e3779b1)) >>> 0);
    let loose = hashString(relation);
    atoms.forEach((atom, column) => {
      loose = (loose + term(atom.loose, column)) >>> 0;
    });
    atoms.forEach((atom, column) => {
      const key = String(row[column]);
      if (!atom.key || hashes.has(key)) {
        return;
      }
      let hash = loose;
      atoms.forEach((other, at) => {
        if (String(row[at]) === key) {
          hash = (hash - term(other.loose, at) + term(other.exact, at)) >>> 0;
        }
      });
      hashes.set(key, hash);
    });
    return hashes;
  }

  /** Digests of one file's own rows, by each key in them. */
  private ownDigests(file: string): Digests {
    const digests = new Digests();
    const range = this.ranges.get(file);
    if (range === undefined) {
      return digests;
    }
    for (const [relation, row] of this.rowsIn(range[0], range[1])) {
      for (const [key, hash] of this.hashesByKey(relation, row)) {
        digests.add(key, hash);
      }
    }
    return digests;
  }

  /** Digests of the rows that join files, by each key in them, grouped by that key's file. */
  private joinedDigests(): {
    digests: Digests;
    keysByFile: Map<string, Set<string>>;
  } {
    const digests = new Digests();
    const keysByFile = new Map<string, Set<string>>();
    for (const [from, to] of this.joinedRanges) {
      for (const [relation, row] of this.rowsIn(from, to)) {
        for (const [key, hash] of this.hashesByKey(relation, row)) {
          digests.add(key, hash);
          const file = this.fileOf(key) as string;
          const keys = keysByFile.get(file) ?? new Set<string>();
          keys.add(key);
          keysByFile.set(file, keys);
        }
      }
    }
    return { digests, keysByFile };
  }

  /**
   * Each file's facts to store. `unchanged` lists the files whose content
   * hashed the same as when `previous` was stored, so their own rows are
   * taken from there instead of being read again.
   */
  stored(
    files: readonly string[],
    previous: ReadonlyMap<string, StoredFacts>,
    unchanged: ReadonlySet<string>,
  ): Map<string, StoredFacts> {
    const joined = this.joinedDigests();
    const out = new Map<string, StoredFacts>();
    for (const file of files) {
      const before = previous.get(file);
      let own: string;
      if (before !== undefined && unchanged.has(file)) {
        own = before.own;
      } else {
        const digests = this.ownDigests(file);
        own = packHashes(digests.pairs(digests.sums.keys()));
      }
      out.set(file, {
        own,
        joined: packHashes(
          joined.digests.pairs(joined.keysByFile.get(file) ?? []),
        ),
      });
    }
    return out;
  }

  /** The hashes of every value whose facts changed since `previous` was stored. `changed` lists the files whose content changed. */
  changedValues(
    changed: ReadonlySet<string>,
    previous: ReadonlyMap<string, StoredFacts>,
  ): Set<number> {
    const values = new Set<number>();
    for (const file of changed) {
      const digests = this.ownDigests(file);
      differing(
        pairsOf(previous.get(file)?.own ?? ""),
        pairsOf(packHashes(digests.pairs(digests.sums.keys()))),
        values,
      );
    }
    const joined = this.joinedDigests();
    const files = new Set([...previous.keys(), ...joined.keysByFile.keys()]);
    for (const file of files) {
      differing(
        pairsOf(previous.get(file)?.joined ?? ""),
        pairsOf(
          packHashes(joined.digests.pairs(joined.keysByFile.get(file) ?? [])),
        ),
        values,
      );
    }
    return values;
  }
}
