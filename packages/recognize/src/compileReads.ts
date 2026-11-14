/**
 * Turns a read chain into the hook the adapter's access walk calls on
 * every property read and every call it visits.
 *
 * At a property read the chain asks whether the read is off its object,
 * and whether the site is the object itself, in which case the reads off
 * it that the walk never visits (a bracket read, a destructured one) are
 * reported from this site, where the walk does stand. At a call it asks
 * which arguments supply a read's key down the callee, and whether the
 * call is a getter or a function that reads the object, whose read
 * replaces the call's own. `siteReadOf` gives what the chain says one
 * site reads, for an adapter's rule about coping with a missing value.
 * DESIGN.md describes each step.
 */

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import { compileSchemaReads } from "./compileSchemaReads.js";
import { opsIn, readIn } from "./ops.js";

import type { Effect } from "@suss/behavioral-ir";
import type { AccessRecognizer } from "@suss/extractor";
import type {
  CalleeSpelling,
  Chain,
  Deployment,
  EntriesBy,
  EntriesLink,
  EntryMeaning,
  FallbackPick,
  FunctionsLink,
  GetterMeaning,
  GettersLink,
  Link,
  MethodMeaning,
  MethodsLink,
  MissingEntry,
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
export interface Reading {
  readonly object: RuntimeObject;
  readonly paths: readonly string[];
  readonly entriesBy: EntriesBy;
  readonly missing: MissingEntry;
  readonly entries: EntriesLink | null;
  readonly writes: WritesLink | null;
  readonly getters: GettersLink | null;
  readonly functions: FunctionsLink | null;
  readonly throughHelpers: boolean;
  readonly deployment: Deployment;
  readonly recognition: string;
}

/** A read chain, as the hook the adapter dispatches to on its access walk. */
export function compileReads(
  chain: Chain<MethodMeaning>,
  recognition: string,
): AccessRecognizer {
  // A chain that lists the calls that parse a schema starts at a call.
  const methods = linkIn<MethodsLink<MethodMeaning>>(chain.links, "methods");
  if (methods !== null) {
    return compileSchemaReads(chain, methods, recognition);
  }
  const reading = readingOf(chain, recognition);
  return (_access: unknown, ctx: unknown): Effect[] | null => {
    const read = readIn(ctx);
    if (read === null) {
      return null;
    }
    const getter = getterIn(ctx, reading);
    const effects = [
      ...(getter === null ? readsAtSite(read, reading) : []),
      ...helperReads(read, reading),
      ...(getter === null ? [] : getterReads(getter, read, reading)),
    ];
    return effects.length === 0 ? null : effects;
  };
}

/** What a read chain says one site reads, before anything asks whether the program copes with a missing value. */
export interface SiteRead {
  /** The entry the source writes out, or null for a key the program works out. */
  readonly entry: string | null;
  /** The key as written, which two reads of one computed key share. */
  readonly keySource: string;
  /** What a getter call passes as its fallback, or null. A block passed as one counts, without a value. */
  readonly fallback: ValueOps | null;
  readonly passesFallback: boolean;
  /** A missing entry raises here: a read at a key under `missing: "raises"`, or a getter with `raisesWithout` and no fallback. */
  readonly raises: boolean;
}

const READINGS = new WeakMap<Chain<MethodMeaning>, Reading>();

/**
 * What a read chain says the site reads, or null when the chain doesn't
 * cover it: an assignment, a member of a mapping, an entry the chain
 * reads as nothing, or a site off another object.
 */
export function siteReadOf(
  chain: Chain<MethodMeaning>,
  ctx: { read: ReadOps; ops: CallOps | null },
): SiteRead | null {
  let reading = READINGS.get(chain);
  if (reading === undefined) {
    reading = readingOf(chain, "");
    READINGS.set(chain, reading);
  }
  const getter = getterIn(ctx, reading);
  if (getter !== null) {
    return getter.site;
  }
  if (!ctx.read.isOff(reading.object)) {
    return null;
  }
  const read = entryRead(ctx.read, reading);
  if (read === null || writeAt(ctx.read, read.entry, reading) !== null) {
    return null;
  }
  const meaning = entryMeaningOf(read.entry, reading.entries);
  if (meaning === null || meaning.reads === "nothing") {
    return null;
  }
  return {
    entry: read.entry,
    keySource:
      read.entry ?? ctx.read.computedKey()?.source?.() ?? ctx.read.source(),
    fallback: null,
    passesFallback: false,
    raises: reading.missing === "raises",
  };
}

/**
 * How a read chain says its object is spelled, for an adapter's own
 * readers of the same spellings: the seeds its rules follow the object
 * from, which run before any facts exist, and its value evaluator's rows.
 */
export interface ReadSpellings {
  /** The global paths the object is spelled as. */
  readonly paths: readonly string[];
  /** The methods called on the object that read one entry. */
  readonly getters: Readonly<Record<string, GetterMeaning>>;
  /** The functions that read one entry, by global path. */
  readonly functions: Readonly<Record<string, GetterMeaning>>;
}

export function readSpellingsOf(chain: Chain<MethodMeaning>): ReadSpellings {
  const reading = readingOf(chain, "");
  return {
    paths: reading.object.origin === "global" ? reading.paths : [],
    getters: reading.getters?.table ?? {},
    functions: reading.functions?.table ?? {},
  };
}

export function readingOf(
  chain: Chain<MethodMeaning>,
  recognition: string,
): Reading {
  const off = linkIn<OffLink>(chain.links, "off");
  if (off === null) {
    throw new Error("a read chain states the object its reads are off");
  }
  return {
    object: off.object,
    paths: PATHS[off.object.origin](off.object as never),
    entriesBy: off.entriesBy ?? "keyOrMember",
    missing: off.missing ?? "nothing",
    entries: linkIn<EntriesLink>(chain.links, "entries"),
    writes: linkIn<WritesLink>(chain.links, "writes"),
    getters: linkIn<GettersLink>(chain.links, "getters"),
    functions: linkIn<FunctionsLink>(chain.links, "functions"),
    throughHelpers: chain.links.some((link) => link.asks === "throughHelpers"),
    deployment: (chain.ending as RuntimeReadEnding).deployment,
    recognition,
  };
}

export function linkIn<T extends Link<MethodMeaning>>(
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

/**
 * The entry a site off the object reads, or null when it doesn't read
 * one: a member of a mapping, a site the facts state no entry at, or an
 * empty key.
 */
function entryRead(
  site: ReadOps,
  reading: Reading,
): { entry: string | null } | null {
  if (reading.entriesBy === "key" && !site.byKey()) {
    return null;
  }
  const entry = site.entry();
  return entry === undefined || entry === "" ? null : { entry };
}

/** What one read off the object is, by its entry: a write, a read, or nothing. */
function readOf(site: ReadOps, reading: Reading): Effect[] {
  const read = entryRead(site, reading);
  if (read === null) {
    return [];
  }
  const { entry } = read;
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
  return [
    ...entryEffect(meaning, { entry, reading, site }),
    ...indexedReads(meaning, site, reading),
  ];
}

/**
 * The reads of entries off the entry's own value, each named the way the
 * meaning's `indexed` says: `process.argv[2]` beside `process.argv`. A key
 * the program works out at run time is the entry's own read already.
 */
function indexedReads(
  meaning: EntryMeaning,
  site: ReadOps,
  reading: Reading,
): Effect[] {
  if (meaning.reads !== "config" || meaning.indexed === undefined) {
    return [];
  }
  const { indexed } = meaning;
  return site.readsOff().flatMap((off) => {
    const key = off.entry();
    if (key === undefined || key === null || key === "") {
      return [];
    }
    return [
      configRead(
        {
          reads: "config",
          named: indexed.replace("{key}", key),
          callee: "site",
        },
        { entry: key, reading, site: off },
      ),
    ];
  });
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
export interface ReadFacts {
  readonly entry: string | null;
  readonly reading: Reading;
  /** The read's own site, or the call a helper or getter read is reported at. */
  readonly site: ReadOps;
  /** Whether the read copes with a missing value, when the call settled it. */
  readonly defaulted?: boolean;
  /** The value a getter call passes as its fallback, null for a block, which has none to record. */
  readonly fallback?: ValueOps | null;
  /** The object's path, when the call settled it. */
  readonly path?: string;
}

function defaultedIn(facts: ReadFacts): boolean {
  return facts.defaulted ?? facts.site.defaulted();
}

function fallbackIn(facts: ReadFacts): ValueOps | null {
  return facts.fallback === undefined ? facts.site.fallback() : facts.fallback;
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
export function configRead(
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
  keyed: (facts) =>
    facts.entry === null
      ? facts.site.source()
      : `${pathIn(facts)}["${facts.entry}"]`,
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

/** A call the chain's getters or functions read through, what it reads, and the object's path for its callee. */
interface GetterCall {
  /** Null when the call doesn't pass a key, so it reads nothing. */
  readonly site: SiteRead | null;
  readonly path: string;
}

/**
 * The getter or function the call is, when it is one: a method in the
 * getters table called on the object, `os.environ.get("B")`, or a
 * function in the functions table, `os.getenv("B")`. Only a chain with
 * either asks for the call's ops, which an adapter may have to state
 * the call's facts to build.
 */
function getterIn(ctx: unknown, reading: Reading): GetterCall | null {
  if (
    (reading.getters === null && reading.functions === null) ||
    reading.object.origin !== "global"
  ) {
    return null;
  }
  const ops = opsIn(ctx);
  if (ops === null) {
    return null;
  }
  const firstPath = reading.paths[0] ?? "";
  const method = ops.method();
  const table = reading.getters?.table;
  if (
    table !== undefined &&
    method !== null &&
    Object.hasOwn(table, method) &&
    ops.receiverIsFrom(reading.object)
  ) {
    return {
      site: getterSiteRead(ops, table[method] as GetterMeaning),
      path: ops.receiverGlobal?.(reading.paths) ?? firstPath,
    };
  }
  const called = Object.entries(reading.functions?.table ?? {}).find(([path]) =>
    ops.isFrom({ origin: "global", paths: [path] }),
  );
  return called === undefined
    ? null
    : { site: getterSiteRead(ops, called[1]), path: firstPath };
}

/**
 * What a getter call reads. Its key is read as the source writes it, so
 * `os.environ.get(KEY)` reads a key the program works out, the way
 * `os.environ[KEY]` does.
 */
function getterSiteRead(ops: CallOps, getter: GetterMeaning): SiteRead | null {
  const key = argumentAt(ops, getter.key);
  if (key === null) {
    return null;
  }
  const written = key.literal?.() ?? null;
  const passed = fallbackPassed(ops, getter);
  return {
    entry: typeof written === "string" ? written : null,
    keySource: key.source?.() ?? "",
    fallback: passed?.value ?? null,
    passesFallback: passed !== null,
    raises: getter.raisesWithout === true && passed === null,
  };
}

/**
 * A getter's read: `os.environ.get("B", "d")` reads `B`, and copes with
 * a missing value through the fallback it passes or by the adapter's own
 * rule, which knows a getter that raises without one.
 */
function getterReads(
  getter: GetterCall,
  read: ReadOps,
  reading: Reading,
): Effect[] {
  const { site } = getter;
  if (site === null || site.entry === "") {
    return [];
  }
  const meaning = entryMeaningOf(site.entry, reading.entries);
  if (meaning === null) {
    return [];
  }
  return entryEffect(meaning, {
    entry: site.entry,
    reading,
    site: read,
    defaulted: site.passesFallback || read.defaulted(),
    ...(site.passesFallback ? { fallback: site.fallback } : {}),
    path: getter.path,
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

/** The fallback a getter call passes, or null when it doesn't pass one. A block passed as one has no value to record. */
function fallbackPassed(
  ops: CallOps,
  getter: GetterMeaning,
): { value: ValueOps | null } | null {
  for (const pick of fallbackPicks(getter)) {
    const passed = "block" in pick ? blockPassed(ops) : argumentAt(ops, pick);
    if (passed !== null) {
      return { value: "block" in pick ? null : passed };
    }
  }
  return null;
}

function blockPassed(ops: CallOps): ValueOps | null {
  return ops.block?.() ?? null;
}

function fallbackPicks(getter: GetterMeaning): readonly FallbackPick[] {
  if (getter.fallback === undefined) {
    return [];
  }
  return Array.isArray(getter.fallback)
    ? getter.fallback
    : [getter.fallback as FallbackPick];
}
