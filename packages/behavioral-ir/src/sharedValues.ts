/**
 * Writes each value a summaries file repeats once, and reads it back.
 *
 * Summaries repeat much of what they say. A GraphQL client summary has a
 * copy of its component's transitions, every summary says which
 * repository it came from, and a transition lists each effect reached
 * before it returns. A file writes an object or array that appears more
 * than once, and prints to at least `SHARED_MIN_CHARS`, in full the first
 * time as `{"$def":n,"$value":...}` and as `{"$ref":n}` after that. A
 * reader puts a copy of the value back in each place before it validates
 * a summary, so it gets what was written. Nothing in a summary is an
 * object whose keys are exactly these, with a number for `n`.
 */

/** A value shorter than this saves too little to be worth a reference. */
export const SHARED_MIN_CHARS = 32;

type Container = Record<string, unknown> | unknown[];

const isContainer = (value: unknown): value is Container =>
  typeof value === "object" && value !== null;

/** What `JSON.stringify` drops from objects and turns into `null` in arrays. */
const isJsonVisible = (value: unknown): boolean =>
  value !== undefined &&
  typeof value !== "function" &&
  typeof value !== "symbol";

const printed = (value: unknown): string =>
  JSON.stringify(isJsonVisible(value) ? value : null) ?? "null";

/** The keys `JSON.stringify` writes for an object, in its order. */
const visibleKeys = (node: Record<string, unknown>): string[] =>
  Object.keys(node).filter((name) => isJsonVisible(node[name]));

const MULTIPLIERS = [0x5bd1e995, 0x1b873593, 0xcc9e2d51, 0x2c1b3c6d] as const;
const SEEDS = [0x9e3779b1, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f] as const;
const ARRAY_TAG = 0x5b;
const OBJECT_TAG = 0x7b;

const mixed = (hash: number, value: number, multiplier: number): number => {
  const product = Math.imul(hash ^ value, multiplier);
  return product ^ (product >>> 15);
};

const combined = (high: number, low: number): number =>
  (high >>> 0) * 2 ** 21 + ((low >>> 0) >>> 11);

/** About how many characters a primitive prints to. Only the threshold reads it. */
const primitiveSize = (value: unknown): number =>
  typeof value === "string" ? value.length + 2 : 5;

/** How a write treats a container it meets. */
const SMALL = 0;
const FIRST = 1;
const REPEAT = 2;

/**
 * The containers a write meets, in the order it meets them: each one's
 * hashes, how it is treated, and how many entries for containers inside
 * it follow it.
 */
class ContainerLog {
  keys = new Float64Array(1024);
  checks = new Float64Array(1024);
  inside = new Uint32Array(1024);
  kinds = new Uint8Array(1024);
  length = 0;

  push(key: number, check: number, kind: number): number {
    if (this.length === this.keys.length) {
      this.keys = grown(this.keys, new Float64Array(this.length * 2));
      this.checks = grown(this.checks, new Float64Array(this.length * 2));
      this.inside = grown(this.inside, new Uint32Array(this.length * 2));
      this.kinds = grown(this.kinds, new Uint8Array(this.length * 2));
    }
    this.keys[this.length] = key;
    this.checks[this.length] = check;
    this.inside[this.length] = 0;
    this.kinds[this.length] = kind;
    this.length += 1;
    return this.length - 1;
  }
}

function grown<T extends Float64Array | Uint32Array | Uint8Array>(
  from: T,
  to: T,
): T {
  to.set(from);
  return to;
}

/**
 * Hashes each container of one summary into a log, from four 32-bit
 * hashes that mix the numbers of the primitives inside it. A primitive
 * gets a number the first time it is seen, so a string is hashed once
 * however often it appears. Two hashes make the key and two check it.
 */
class Hasher {
  readonly log = new ContainerLog();
  private readonly numbers = new Map<unknown, number>();
  // What the last value hashed left behind for its parent: its four
  // hashes, or a primitive's number in all four.
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;

  hash(summary: unknown): void {
    this.log.length = 0;
    this.value(summary);
  }

  private numberOf(primitive: unknown): number {
    let number = this.numbers.get(primitive);
    if (number === undefined) {
      number = this.numbers.size + 1;
      this.numbers.set(primitive, number);
    }
    return number;
  }

  /** The size a value prints to, with its hashes left for the caller. */
  private value(item: unknown): number {
    if (isContainer(item)) {
      return this.container(item);
    }
    const number = this.numberOf(isJsonVisible(item) ? item : null);
    this.a = number;
    this.b = number;
    this.c = number;
    this.d = number;
    return primitiveSize(item);
  }

  private container(node: Container): number {
    const at = this.log.push(0, 0, SMALL);
    const tag = Array.isArray(node) ? ARRAY_TAG : OBJECT_TAG;
    let a = mixed(SEEDS[0], tag, MULTIPLIERS[0]);
    let b = mixed(SEEDS[1], tag, MULTIPLIERS[1]);
    let c = mixed(SEEDS[2], tag, MULTIPLIERS[2]);
    let d = mixed(SEEDS[3], tag, MULTIPLIERS[3]);
    let size = 2;
    const names = Array.isArray(node) ? null : visibleKeys(node);
    const count = names === null ? (node as unknown[]).length : names.length;
    for (let index = 0; index < count; index++) {
      let item: unknown;
      if (names === null) {
        item = (node as unknown[])[index];
      } else {
        const name = names[index] as string;
        item = (node as Record<string, unknown>)[name];
        const number = this.numberOf(name);
        a = mixed(a, number, MULTIPLIERS[0]);
        b = mixed(b, number, MULTIPLIERS[1]);
        c = mixed(c, number, MULTIPLIERS[2]);
        d = mixed(d, number, MULTIPLIERS[3]);
        size += name.length + 3;
      }
      size += this.value(item) + 1;
      a = mixed(a, this.a, MULTIPLIERS[0]);
      b = mixed(b, this.b, MULTIPLIERS[1]);
      c = mixed(c, this.c, MULTIPLIERS[2]);
      d = mixed(d, this.d, MULTIPLIERS[3]);
    }
    this.log.keys[at] = combined(a, b);
    this.log.checks[at] = combined(c, d);
    this.log.kinds[at] = size >= SHARED_MIN_CHARS ? FIRST : SMALL;
    this.log.inside[at] = this.log.length - at - 1;
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    return size;
  }
}

/**
 * What the writer meets in every summary, in order, and how often each
 * value appears where it would be written. A value seen before is a
 * repeat, and nothing inside it is met, so nothing inside it is counted.
 */
function surveyed(summaries: readonly unknown[]): {
  log: ContainerLog;
  counts: Map<number, number>;
} {
  const hasher = new Hasher();
  const log = new ContainerLog();
  const counts = new Map<number, number>();
  for (const summary of summaries) {
    hasher.hash(summary);
    const met = hasher.log;
    // The entries still open, as where each is in `log` and where its
    // inside ends in `met`.
    const open: [number, number][] = [];
    let at = 0;
    while (at < met.length) {
      while (open.length > 0 && (open.at(-1) as [number, number])[1] <= at) {
        const [entry] = open.pop() as [number, number];
        log.inside[entry] = log.length - entry - 1;
      }
      const key = met.keys[at] as number;
      const check = met.checks[at] as number;
      const after = at + 1 + (met.inside[at] as number);
      const seen = at === 0 ? 0 : (counts.get(key) ?? 0);
      if (met.kinds[at] === SMALL || seen > 0) {
        log.push(key, check, met.kinds[at] === SMALL ? SMALL : REPEAT);
        if (met.kinds[at] !== SMALL) {
          counts.set(key, seen + 1);
        }
        at = after;
        continue;
      }
      if (at > 0) {
        counts.set(key, 1);
      }
      open.push([log.push(key, check, FIRST), after]);
      at += 1;
    }
    for (const [entry] of open) {
      log.inside[entry] = log.length - entry - 1;
    }
  }
  return { log, counts };
}

/**
 * Each summary's line, with every repeated value written in full where
 * it first appears and as a reference after. A summary itself is always
 * written out, so each line is one summary.
 */
export function* sharedSummaryLines(
  summaries: readonly unknown[],
): Generator<string> {
  const { log, counts } = surveyed(summaries);
  const repeats = (entry: number): boolean =>
    log.kinds[entry] === REPEAT ||
    (log.kinds[entry] === FIRST &&
      (counts.get(log.keys[entry] as number) ?? 0) > 1);
  // How many entries before each one repeat, so whether anything inside
  // an entry repeats is one subtraction.
  const repeatsBefore = new Uint32Array(log.length + 1);
  for (let entry = 0; entry < log.length; entry++) {
    repeatsBefore[entry + 1] =
      (repeatsBefore[entry] as number) + (repeats(entry) ? 1 : 0);
  }
  const written = new Map<number, { id: number; check: number }>();
  let next = 0;

  const write = (node: unknown, top: boolean): string => {
    if (!isContainer(node)) {
      return printed(node);
    }
    const entry = next++;
    const kind = log.kinds[entry];
    const key = log.keys[entry] as number;
    const check = log.checks[entry] as number;
    if (kind === SMALL) {
      return JSON.stringify(node);
    }
    if (kind === REPEAT) {
      const earlier = written.get(key);
      // A key matched by chance: the value is written out in full.
      return earlier !== undefined && earlier.check === check
        ? `{"$ref":${earlier.id}}`
        : JSON.stringify(node);
    }
    const last = entry + (log.inside[entry] as number);
    const shared = !top && repeats(entry);
    if (!shared && repeatsBefore[last + 1] === repeatsBefore[entry + 1]) {
      next = last + 1;
      return JSON.stringify(node);
    }
    const text = inside(node);
    if (!shared) {
      return text;
    }
    const id = written.size + 1;
    written.set(key, { id, check });
    return `{"$def":${id},"$value":${text}}`;
  };

  const inside = (node: Container): string => {
    if (Array.isArray(node)) {
      return `[${node.map((item) => write(item, false)).join(",")}]`;
    }
    const fields = visibleKeys(node).map(
      (name) => `${JSON.stringify(name)}:${write(node[name], false)}`,
    );
    return `{${fields.join(",")}}`;
  };

  for (const summary of summaries) {
    yield write(summary, true);
  }
}

const isReference = (node: Record<string, unknown>): boolean =>
  typeof node.$ref === "number" && Object.keys(node).length === 1;

const isDefinition = (node: Record<string, unknown>): boolean =>
  typeof node.$def === "number" &&
  "$value" in node &&
  Object.keys(node).length === 2;

/**
 * A copy of parsed JSON. Validation hands back loosely typed fields such
 * as an invocation's `args` as they came in, so each place a shared
 * value goes back gets its own, as it would from a file without them.
 */
function copied(node: unknown): unknown {
  if (!isContainer(node)) {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(copied);
  }
  const copy: Record<string, unknown> = {};
  for (const name of Object.keys(node)) {
    copy[name] = copied(node[name]);
  }
  return copy;
}

/**
 * Puts shared values back where a file referred to them, one summary at
 * a time and in file order. One reader per file, since a reference
 * points at a value written earlier in the same file.
 */
export class SharedValueReader {
  private readonly defined = new Map<number, unknown>();

  /** The element with its references replaced, changed in place. */
  expand(node: unknown): unknown {
    if (!isContainer(node)) {
      return node;
    }
    if (Array.isArray(node)) {
      for (let at = 0; at < node.length; at++) {
        node[at] = this.expand(node[at]);
      }
      return node;
    }
    if (isReference(node)) {
      return this.defined.has(node.$ref as number)
        ? copied(this.defined.get(node.$ref as number))
        : node;
    }
    if (isDefinition(node)) {
      const value = this.expand(node.$value);
      this.defined.set(node.$def as number, value);
      return value;
    }
    for (const name of Object.keys(node)) {
      node[name] = this.expand(node[name]);
    }
    return node;
  }
}
