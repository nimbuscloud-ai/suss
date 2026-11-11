/**
 * Turns a read chain into the hook the adapter's access walk calls on
 * every property read and every call it visits.
 *
 * At a property read the chain asks whether the read is off its object,
 * and whether the site is the object itself, in which case the reads off
 * it that the walk never visits (a bracket read, a destructured one) are
 * reported from this site, where the walk does stand. At a call it asks
 * which arguments supply a read's key down the callee, and whether the
 * call is a getter on the object. DESIGN.md describes each step.
 */

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import { opsIn, readIn } from "./ops.js";

import type { Effect } from "@suss/behavioral-ir";
import type { AccessRecognizer } from "@suss/extractor";
import type {
  CalleeSpelling,
  Chain,
  Deployment,
  EntriesLink,
  EntryMeaning,
  FallbackPick,
  GetterMeaning,
  GettersLink,
  Link,
  MethodMeaning,
  OffLink,
  RuntimeReadEnding,
  WriteMeaning,
  WritesLink,
} from "./chain.js";
import type {
  CallOps,
  ReadOps,
  RuntimeObject,
  SuppliedKey,
  ValueOps,
} from "./ops.js";

/** A read chain's links, picked out once when it compiles. */
interface Reading {
  readonly object: RuntimeObject;
  readonly paths: readonly string[];
  readonly entries: EntriesLink | null;
  readonly writes: WritesLink | null;
  readonly getters: GettersLink | null;
  readonly throughHelpers: boolean;
  readonly deployment: Deployment;
  readonly recognition: string;
}

/** A read chain, as the hook the adapter dispatches to on its access walk. */
export function compileReads(
  chain: Chain<MethodMeaning>,
  recognition: string,
): AccessRecognizer {
  const reading = readingOf(chain, recognition);
  return (_access: unknown, ctx: unknown): Effect[] | null => {
    const read = readIn(ctx);
    if (read === null) {
      return null;
    }
    // Only a getter needs the call's ops, which an adapter may have to
    // state the call's facts to build, so they are asked for nowhere else.
    const ops = reading.getters === null ? null : opsIn(ctx);
    const effects = [
      ...readsAtSite(read, reading),
      ...helperReads(read, reading),
      ...(ops === null ? [] : getterReads(ops, read, reading)),
    ];
    return effects.length === 0 ? null : effects;
  };
}

function readingOf(chain: Chain<MethodMeaning>, recognition: string): Reading {
  const off = linkIn<OffLink>(chain.links, "off");
  if (off === null) {
    throw new Error("a read chain states the object its reads are off");
  }
  return {
    object: off.object,
    paths: PATHS[off.object.origin](off.object as never),
    entries: linkIn<EntriesLink>(chain.links, "entries"),
    writes: linkIn<WritesLink>(chain.links, "writes"),
    getters: linkIn<GettersLink>(chain.links, "getters"),
    throughHelpers: chain.links.some((link) => link.asks === "throughHelpers"),
    deployment: (chain.ending as RuntimeReadEnding).deployment,
    recognition,
  };
}

function linkIn<T extends Link<MethodMeaning>>(
  links: readonly Link<MethodMeaning>[],
  asks: T["asks"],
): T | null {
  return (links.find((link) => link.asks === asks) as T | undefined) ?? null;
}

/**
 * The paths a runtime object is spelled as, which a dotted callee starts
 * with. A parameter the platform fills is spelled as its own name.
 */
const PATHS: {
  readonly [K in RuntimeObject["origin"]]: (
    object: Extract<RuntimeObject, { origin: K }>,
  ) => readonly string[];
} = {
  global: (object) => object.paths,
  handedIn: (object) => [object.name],
};

/**
 * The reads at a property read: the site's own, when it is off the
 * object, and the ones off the site's value when the site is the object.
 */
function readsAtSite(read: ReadOps, reading: Reading): Effect[] {
  const own = read.isOff(reading.object) ? readOf(read, reading) : [];
  if (!isTheObject(read, reading)) {
    return own;
  }
  return [
    ...own,
    ...read
      .readsOff()
      .filter((off) => off.isOff(reading.object))
      .flatMap((off) => readOf(off, reading)),
  ];
}

/**
 * Whether the site is spelled as one of the object's paths: `process.env`
 * read off `process`. Asking the object of the site first keeps the
 * entry, which the adapter may state facts to answer, to the few sites
 * read off the path's own object.
 */
function isTheObject(read: ReadOps, reading: Reading): boolean {
  return reading.paths.some((path) => {
    const dot = path.lastIndexOf(".");
    if (dot < 0) {
      return false;
    }
    const parent = path.slice(0, dot);
    return (
      read.objectPath([parent]) === parent &&
      read.entry() === path.slice(dot + 1)
    );
  });
}

/** What one read off the object is, by its entry: a write, a read, or nothing. */
function readOf(site: ReadOps, reading: Reading): Effect[] {
  const entry = site.entry();
  if (entry === undefined || entry === "") {
    return [];
  }
  const write = writeAt(site, entry, reading);
  if (write !== null) {
    return write.meaning.changes === "state"
      ? [stateChange(site.source(), write.assigned)]
      : [];
  }
  const meaning = entryMeaningOf(entry, reading.entries);
  if (meaning === null) {
    return [];
  }
  return entryEffect(meaning, { entry, reading, site });
}

/** The table's own entry for a key, then `otherwise`. A computed key, which is null, only ever takes `otherwise`. */
function entryMeaningOf(
  entry: string | null,
  link: EntriesLink | null,
): EntryMeaning | null {
  if (link === null) {
    return null;
  }
  const listed =
    entry !== null && Object.hasOwn(link.table, entry)
      ? link.table[entry]
      : undefined;
  return listed ?? link.otherwise ?? null;
}

function writeMeaningOf(
  entry: string | null,
  link: WritesLink | null,
): WriteMeaning | null {
  if (link === null) {
    return null;
  }
  const listed =
    entry !== null && Object.hasOwn(link.table, entry)
      ? link.table[entry]
      : undefined;
  return listed ?? link.otherwise ?? null;
}

/**
 * What the chain says an assignment to the site does, with the value
 * assigned, or null when the site is no assignment the chain lists. The
 * site is asked only when the chain lists one, since an adapter may
 * state facts to answer.
 */
function writeAt(
  site: ReadOps,
  entry: string | null,
  reading: Reading,
): { meaning: WriteMeaning; assigned: ValueOps } | null {
  const meaning = writeMeaningOf(entry, reading.writes);
  const assigned = meaning === null ? null : site.assigned();
  return meaning === null || assigned === null ? null : { meaning, assigned };
}

/**
 * `process.exitCode = 1` sets the code the process ends with once its
 * work drains, so the function keeps going and the assignment is a state
 * change rather than a terminal. A number the value settles to is the
 * new value, and the source as written is otherwise.
 */
function stateChange(variable: string, assigned: ValueOps): Effect {
  const settled = assigned.evaluated?.() ?? null;
  return {
    type: "stateChange",
    variable,
    newValue:
      typeof settled === "number" && Number.isFinite(settled)
        ? settled
        : (assigned.source?.() ?? ""),
  };
}

/**
 * What a read's effect is built from. The site is asked only for what the
 * meaning needs, and a read through a helper or a getter says up front
 * what it worked out at the call instead.
 */
interface ReadFacts {
  readonly entry: string | null;
  readonly reading: Reading;
  /** The read's own site, or the call a helper or getter read is reported at. */
  readonly site: ReadOps;
  /** Whether the read copes with a missing value, when the call settled it. */
  readonly defaulted?: boolean;
  /** The value a getter call passes as its fallback. */
  readonly fallback?: ValueOps;
  /** The object's path, when the call settled it. */
  readonly path?: string;
}

function defaultedIn(facts: ReadFacts): boolean {
  return facts.defaulted ?? facts.site.defaulted();
}

function fallbackIn(facts: ReadFacts): ValueOps | null {
  return facts.fallback ?? facts.site.fallback();
}

/** The object's path, for a callee spelled from it. */
function pathIn(facts: ReadFacts): string {
  const { paths } = facts.reading;
  return facts.path ?? facts.site.objectPath(paths) ?? paths[0] ?? "";
}

/** The effect a meaning gives, one function per kind of read. */
const ENTRY_EFFECT: {
  readonly [K in EntryMeaning["reads"]]: (
    meaning: Extract<EntryMeaning, { reads: K }>,
    facts: ReadFacts,
  ) => Effect[];
} = {
  config: (meaning, facts) => [configRead(meaning, facts)],
  metadata: (meaning, facts) => {
    const callee = calleeOf(meaning.callee ?? "site", facts);
    return [
      {
        type: "interaction",
        binding: runtimeConfigBinding({
          recognition: facts.reading.recognition,
        }),
        callee,
        interaction: { class: "metadata-read", name: callee },
      },
    ];
  },
  nothing: () => [],
};

function entryEffect(meaning: EntryMeaning, facts: ReadFacts): Effect[] {
  const build = ENTRY_EFFECT[meaning.reads] as (
    meaning: EntryMeaning,
    facts: ReadFacts,
  ) => Effect[];
  return build(meaning, facts);
}

/**
 * A config read, named after its entry. One that copes with a missing
 * value records the value it falls back to, when that settles to one.
 */
function configRead(
  meaning: Extract<EntryMeaning, { reads: "config" }>,
  facts: ReadFacts,
): Effect {
  const defaulted = defaultedIn(facts);
  const fallback = defaulted
    ? (fallbackIn(facts)?.evaluated?.() ?? null)
    : null;
  return {
    type: "interaction",
    binding: runtimeConfigBinding({
      recognition: facts.reading.recognition,
      ...facts.reading.deployment,
    }),
    callee: calleeOf(meaning.callee ?? "dotted", facts),
    interaction: {
      class: "config-read",
      name: meaning.named ?? facts.entry,
      defaulted,
      ...(fallback === null ? {} : { default: fallback }),
    },
  };
}

/** How each spelling writes a callee. A read with no name is spelled as written whatever the meaning says. */
const CALLEE: Record<CalleeSpelling, (facts: ReadFacts) => string> = {
  dotted: (facts) =>
    facts.entry === null
      ? facts.site.source()
      : `${pathIn(facts)}.${facts.entry}`,
  site: (facts) => facts.site.source(),
  object: (facts) => pathIn(facts),
};

function calleeOf(spelling: CalleeSpelling, facts: ReadFacts): string {
  return CALLEE[spelling](facts);
}

/**
 * The reads a call makes through a helper whose parameter supplies the
 * key: one per name, in the order the arguments first pass it. A name
 * counts as defaulted when every site that reads it copes with a missing
 * value, or when the call itself does.
 */
function helperReads(read: ReadOps, reading: Reading): Effect[] {
  if (!reading.throughHelpers) {
    return [];
  }
  const keys = read.keysSuppliedTo(reading.object);
  if (keys === null || keys.length === 0) {
    return [];
  }
  const byName = namesSupplied(keys, reading);
  if (byName.size === 0) {
    return [];
  }
  const wrapped = read.defaulted();
  return [...byName].flatMap(([name, supplied]) => {
    const meaning = entryMeaningOf(name, reading.entries);
    return meaning === null
      ? []
      : entryEffect(meaning, {
          entry: name,
          reading,
          site: read,
          defaulted: supplied.defaulted || wrapped,
          path: supplied.path,
        });
  });
}

interface Supplied {
  defaulted: boolean;
  path: string;
}

/**
 * The names the call's arguments settle to, each with whether every
 * site reading it copes with a missing value and the object its first
 * site reads. A forwarded key belongs to whoever calls the caller, and a
 * helper that only assigns the entry it is handed reads nothing.
 */
function namesSupplied(
  keys: readonly SuppliedKey[],
  reading: Reading,
): Map<string, Supplied> {
  const byName = new Map<string, Supplied>();
  for (const key of keys) {
    if (key.sites.length === 0 || key.forwarded) {
      continue;
    }
    const name = key.value.evaluated?.() ?? null;
    if (typeof name !== "string" || name.length === 0) {
      continue;
    }
    const sites = key.sites.filter(
      (site) => writeAt(site, site.entry() ?? null, reading) === null,
    );
    const [first] = sites;
    if (first === undefined) {
      continue;
    }
    const everywhere = sites.every((site) => site.defaulted());
    const known = byName.get(name);
    byName.set(name, {
      defaulted: (known?.defaulted ?? true) && everywhere,
      path:
        known?.path ??
        first.objectPath(reading.paths) ??
        reading.paths[0] ??
        "",
    });
  }
  return byName;
}

/**
 * A getter's read: `os.environ.get("B", "d")` reads `B`, and copes with
 * a missing value through the fallback it passes.
 */
function getterReads(ops: CallOps, read: ReadOps, reading: Reading): Effect[] {
  const method = ops.method();
  const table = reading.getters?.table;
  if (
    table === undefined ||
    method === null ||
    !Object.hasOwn(table, method) ||
    reading.object.origin !== "global" ||
    !ops.receiverIsFrom(reading.object)
  ) {
    return [];
  }
  const getter = table[method] as GetterMeaning;
  const key = argumentAt(ops, getter.key)?.evaluated?.() ?? null;
  const entry = typeof key === "string" ? key : null;
  const meaning = entryMeaningOf(entry, reading.entries);
  if (meaning === null || entry === "") {
    return [];
  }
  const fallback = fallbackPassed(ops, getter);
  return entryEffect(meaning, {
    entry,
    reading,
    site: read,
    defaulted:
      fallback !== null || (getter.raisesWithout !== true && read.defaulted()),
    ...(fallback === null ? {} : { fallback }),
    path: ops.receiverGlobal?.(reading.paths) ?? reading.paths[0] ?? "",
  });
}

/** The value passed under the keyword when the call passes one there, else the value at the position. */
function argumentAt(
  ops: CallOps,
  position: { at: number; keyword?: string },
): ValueOps | null {
  const named =
    position.keyword === undefined
      ? null
      : (ops.keywordAt?.(position.keyword) ?? null);
  return named ?? ops.valueAt(position.at);
}

/** The fallback a getter call passes, or null when it passes none. A block passed as one has no value to record. */
function fallbackPassed(ops: CallOps, getter: GetterMeaning): ValueOps | null {
  for (const pick of fallbackPicks(getter)) {
    const passed =
      "block" in pick ? (ops.block?.() ?? null) : argumentAt(ops, pick);
    if (passed !== null) {
      return passed;
    }
  }
  return null;
}

function fallbackPicks(getter: GetterMeaning): readonly FallbackPick[] {
  if (getter.fallback === undefined) {
    return [];
  }
  return Array.isArray(getter.fallback)
    ? getter.fallback
    : [getter.fallback as FallbackPick];
}
