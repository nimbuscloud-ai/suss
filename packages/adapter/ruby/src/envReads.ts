/**
 * The environment variables a body reads through Ruby's `ENV` object.
 * `ENV["X"]`, `ENV.fetch("X", d)` and `ENV.fetch("X") { d }` become the
 * config-read effect the TypeScript adapter emits for `process.env.X`,
 * with the same defaulted flag, so the runtime-config checker pairs them
 * with a template the same way.
 *
 * `ENV` is part of the language, so this belongs to the adapter and not
 * to a pack. Every expression that passes `ENV` somewhere becomes an
 * `environmentObject` fact. One question over those facts returns every
 * parameter whose value ends up naming a variable, so a body that calls
 * such a helper reports the read at the call.
 */

import { runtimeConfigBinding } from "@suss/behavioral-ir";
import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";
import { answersFor, noteLookup } from "@suss/resolution";
import { scalarOf } from "@suss/values";

import {
  children,
  enclosingDefinition,
  field,
  NodeMap,
  rangeOf,
  readCallArgs,
  stringLiteralValue,
} from "./ast.js";
import { fallbackOperandOf, isDefaultedAt } from "./defaulted.js";
import { envSpellingAt, isEnv } from "./envSpellings.js";
import { CONSTRUCTOR } from "./facts/languageWords.js";
import { parametersOf } from "./facts/locals.js";
import {
  resolvedFunctions,
  resolveEnvObjects,
  resolveValues,
} from "./facts/resolve.js";
import { calleeKeyOf, invokedKeyOf, nodeId, readKey } from "./facts/values.js";
import { evaluatedValue, stringValueOf } from "./values/evaluator.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database, Tuple } from "@suss/datalog";
import type { RbNode } from "./parser.js";
import type { EffectAt } from "./paths/effects.js";

export const RUBY_ENV_RECOGNITION = "ruby-env";

/**
 * Marks a read whose variable name is not a literal and which supplies a
 * fallback. The fallback is written at the read and the shared rules do
 * not carry it, so the adapter records it in a relation of its own. A
 * read site with no row here has no fallback.
 */
const ENV_DEFAULTED = "rbEnvDefaulted";

/** The project's facts, and the path they use as this body's file key. */
export interface EnvFacts {
  readonly db: Database;
  readonly file: string;
}

/** The same facts, for a run with at least one helper that reads the environment. */
interface HelperFacts extends EnvFacts {
  /** Each parameter whose value becomes a variable name, with the read sites that name reaches. */
  readonly named: ReadonlyMap<string, readonly string[]>;
}

interface EnvRead {
  /**
   * Null when the code works the name out at run time, as a helper's
   * `ENV[name]` does. Each call to the helper records its own read with
   * the name it passes.
   */
  name: string | null;
  defaulted: boolean;
  /** The value used when the variable is not set, when it settles to one. */
  fallback?: string | number | boolean;
}

/** An `ENV` read before its name expression has been read as a string. */
interface EnvSite {
  /** The whole read, whose node id is the site the rules report. */
  readonly read: RbNode;
  /** Where the variable's name comes from. */
  readonly name: RbNode;
  readonly defaulted: boolean;
  /** The expression that supplies a value when the variable is not set. */
  readonly fallback: RbNode | null;
}

/** What a caller passes for a parameter the rules found. */
interface NamingArgument {
  /** The reads the parameter's value supplies the name to. */
  readonly sites: readonly string[];
  readonly argument: RbNode;
}

/** A place in the body's source order: a read found there, or a call still to resolve. */
type Slot =
  | { readonly read: EnvRead; readonly at: RbNode }
  | { readonly call: RbNode };

/** A method or lambda body runs when it is called, so its reads wait for its own unit. */
const DEFERRED_BODY_TYPES = new Set(["method", "singleton_method", "lambda"]);

/**
 * The config-read effects for every environment read under `root`,
 * in source order. `root` itself is not read: pass a method for its
 * body, or the program node for what runs when the file loads.
 *
 * With the run's facts, a call to a project helper that reads the
 * environment through one of its parameters reports the read here too.
 */
export function envReadEffects(root: RbNode, facts?: EnvFacts): EffectAt[] {
  const helpers = helperFactsOf(facts);
  const defaults = facts !== undefined && hasDefaultReads(facts.db);
  const blankToNil = blankToNilIn(facts?.db);
  // The calls are resolved in one batch after the walk, so the walk keeps
  // a slot for each one to preserve source order.
  const slots: Slot[] = [];
  walkDescendants<RbNode, null>(root, null, children, {
    at: (node) => {
      const read = envReadAt(node, blankToNil, facts?.db);
      if (read !== null) {
        slots.push({ read, at: node });
        return;
      }
      // A bare method call parses as an `identifier` and takes no
      // arguments, so it cannot pass a name to a helper. `Client.new`
      // with no parentheses is a `call` and can still run a default.
      if ((helpers !== null || defaults) && node.type === "call") {
        slots.push({ call: node });
      }
    },
    into: (node) =>
      DEFERRED_BODY_TYPES.has(node.type) || isOwnParameter(node, root)
        ? SKIP_CHILDREN
        : null,
  });

  const calls = slots.flatMap((slot) => ("call" in slot ? [slot.call] : []));
  const throughHelpers =
    facts === undefined || calls.length === 0
      ? new NodeMap<EnvRead[]>()
      : callReads(calls, facts, helpers, defaults);
  return slots.flatMap((slot): EffectAt[] => {
    if ("read" in slot) {
      return [{ effect: configReadEffect(slot.read, slot.at), at: slot.at }];
    }
    return (throughHelpers.get(slot.call) ?? []).map((read) => ({
      effect: configReadEffect(read, slot.call),
      at: slot.call,
    }));
  });
}

/**
 * The run's facts with the parameters that name a variable, or null when
 * no parameter in the run does. The body's calls are then skipped.
 */
function helperFactsOf(facts: EnvFacts | undefined): HelperFacts | null {
  if (facts === undefined) {
    return null;
  }
  const named = namedParameters(facts.db);
  noteLookup(facts.db, NAMED_ANY, describeAny(named));
  if (named.size === 0) {
    return null;
  }
  return { ...facts, named };
}

const NAMED_ANY = "envNamedAny";
const NAMED_PARAMETER = "envNamed ";

const describeAny = (named: ReadonlyMap<string, unknown>): string =>
  named.size === 0 ? "none" : "some";

const describeSites = (sites: readonly string[] | undefined): string =>
  sites === undefined ? "-" : sites.join(",");

/** The reads a parameter names, noted so a later run can tell whether that changed. */
function sitesNamedBy(
  db: Database,
  named: ReadonlyMap<string, readonly string[]>,
  parameter: string,
): readonly string[] | undefined {
  const sites = named.get(parameter);
  noteLookup(db, `${NAMED_PARAMETER}${parameter}`, describeSites(sites));
  return sites;
}

/**
 * Asks the run's one question about which parameters name a variable,
 * so it is answered before any file's work starts and no one file is
 * charged for every file's reads.
 */
export function settleNamedParameters(db: Database): void {
  namedParameters(db);
}

/**
 * The same lookup `envReadEffects` noted under `id`, made again in this
 * run, or null when `id` is not one of these.
 */
export function envLookupAgain(db: Database, id: string): string | null {
  if (id === NAMED_ANY) {
    return describeAny(namedParameters(db));
  }
  if (id.startsWith(NAMED_PARAMETER)) {
    return describeSites(
      namedParameters(db).get(id.slice(NAMED_PARAMETER.length)),
    );
  }
  if (id === DEFAULTS_ANY) {
    return db.facts(DEFAULT_READ).length > 0 ? "some" : "none";
  }
  if (id.startsWith(DEFAULT_PARAMETER)) {
    return describeDefaults(
      db.lookup(DEFAULT_READ, 0, id.slice(DEFAULT_PARAMETER.length)),
    );
  }
  return null;
}

/** The answer, kept per run, since the question covers the whole project. */
const namedByDb = new WeakMap<Database, Map<string, string[]>>();

/**
 * Every parameter whose value ends up naming an environment variable,
 * mapped to the read sites the name reaches. It asks one question per
 * run, starting from the expressions that spell `ENV`, and follows the
 * name through any number of helpers. The reads cannot be the starting
 * point, because a read through a parameter is made on an object no scan
 * of the source would recognize as `ENV`.
 */
function namedParameters(db: Database): ReadonlyMap<string, readonly string[]> {
  const memo = namedByDb.get(db);
  if (memo !== undefined) {
    return memo;
  }
  const named = new Map<string, string[]>();
  namedByDb.set(db, named);
  const objects = db.facts("environmentObject").map((row) => String(row[0]));
  if (objects.length === 0) {
    return named;
  }
  resolveEnvObjects(db, objects);
  for (const row of db.facts("wantedParamNamesEnv")) {
    const found = named.get(String(row[0]));
    if (found === undefined) {
      named.set(String(row[0]), [String(row[1])]);
      continue;
    }
    found.push(String(row[1]));
  }
  return named;
}

const BLANK_TO_NIL = "rbBlankToNil";

/** Records the methods the run's packs say turn a blank value into nil, for the defaulted rule. */
export function emitBlankToNilFacts(
  db: Database,
  methods: readonly string[],
): void {
  for (const method of methods) {
    db.add(BLANK_TO_NIL, [method]);
  }
}

const NO_METHODS: ReadonlySet<string> = new Set();

function blankToNilIn(db: Database | undefined): ReadonlySet<string> {
  const rows = db?.facts(BLANK_TO_NIL) ?? [];
  return rows.length === 0
    ? NO_METHODS
    : new Set(rows.map((row) => String(row[0])));
}

/**
 * Records which expressions spell `ENV` and pass it on, so the shared
 * rules can work out which parameters a caller's argument ends up
 * naming. Also records the fallback flag the rules do not carry.
 */
export function emitEnvFacts(db: Database, file: string, root: RbNode): void {
  const blankToNil = blankToNilIn(db);
  walkDescendants<RbNode, null>(root, null, children, {
    at: (node) => {
      if (DEFAULTED_PARAMETER_HOLDERS.has(node.type)) {
        emitDefaultReads(db, file, node, blankToNil);
      }
      if (isEnv(node) && handsOnward(node)) {
        db.add("environmentObject", [
          readKey(file, node, enclosingDefinition(node)),
        ]);
      }
      const spelling = envSpellingAt(node);
      if (
        spelling !== null &&
        stringLiteralValue(spelling.name) === null &&
        envSiteAt(node, blankToNil)?.defaulted === true
      ) {
        db.add(ENV_DEFAULTED, [nodeId(file, node)]);
      }
    },
    into: () => null,
  });
}

/**
 * The reads in each parameter default of a method, keyed by the
 * parameter the shared facts give it. A default runs at the call that
 * leaves its argument out, so the call reports the read and the method
 * does not. The kind says whether a call leaves it out by passing too
 * few arguments or by not naming its keyword.
 */
const DEFAULT_READ = "rbEnvDefaultRead";

const DEFAULTED_PARAMETER_HOLDERS = new Set(["method", "singleton_method"]);

const DEFAULTS_ANY = "envDefaultsAny";
const DEFAULT_PARAMETER = "envDefault ";

/** Whether any parameter default in the run reads the environment, noted so a later run can tell whether that changed. */
function hasDefaultReads(db: Database): boolean {
  const any = db.facts(DEFAULT_READ).length > 0;
  noteLookup(db, DEFAULTS_ANY, any ? "some" : "none");
  return any;
}

/** One parameter default's reads, noted so a later run can tell whether they changed. */
function defaultReadsOf(db: Database, paramKey: string): readonly Tuple[] {
  const rows = db.lookup(DEFAULT_READ, 0, paramKey);
  noteLookup(db, `${DEFAULT_PARAMETER}${paramKey}`, describeDefaults(rows));
  return rows;
}

const describeDefaults = (rows: readonly Tuple[]): string =>
  rows.length === 0 ? "-" : rows.map((row) => row.slice(1).join(":")).join(",");

const DEFAULT_KIND: Record<string, "positional" | "keyword"> = {
  optional_parameter: "positional",
  keyword_parameter: "keyword",
};

function emitDefaultReads(
  db: Database,
  file: string,
  method: RbNode,
  blankToNil: ReadonlySet<string>,
): void {
  const funcKey = nodeId(file, method);
  for (const param of parametersOf(method)) {
    const kind = DEFAULT_KIND[param.type];
    const name = field(param, "name");
    const value = field(param, "value");
    if (kind === undefined || name === null || value === null) {
      continue;
    }
    for (const read of namedReadsUnder(value, blankToNil)) {
      db.add(DEFAULT_READ, [
        `${funcKey}#${name.text}`,
        kind,
        read.name,
        read.defaulted ? 1 : 0,
      ]);
    }
  }
}

/** The reads under a node that write out their variable, the node itself included. */
function namedReadsUnder(
  node: RbNode,
  blankToNil: ReadonlySet<string>,
): Array<{ name: string; defaulted: boolean }> {
  const reads: Array<{ name: string; defaulted: boolean }> = [];
  const take = (at: RbNode): void => {
    const read = envReadAt(at, blankToNil);
    if (read?.name !== null && read?.name !== undefined) {
      reads.push({ name: read.name, defaulted: read.defaulted });
    }
  };
  take(node);
  walkDescendants<RbNode, null>(node, null, children, {
    at: take,
    into: (inner) =>
      DEFERRED_BODY_TYPES.has(inner.type) ? SKIP_CHILDREN : null,
  });
  return reads;
}

/** Whether a node is the default of one of `root`'s own parameters. */
function isOwnParameter(node: RbNode, root: RbNode): boolean {
  return (
    DEFAULT_KIND[node.type] !== undefined && node.parent?.parent?.id === root.id
  );
}

/**
 * The reads in the defaults a call runs: those of the parameters it
 * passes nothing for, across every method the callee settles on.
 */
function defaultReadsAtCall(
  db: Database,
  call: RbNode,
  callees: readonly string[],
): EnvRead[] {
  const { positional, keyword } = readCallArgs(field(call, "arguments"));
  const omitted: Array<{ paramKey: string; kind: string }> = [];
  for (const func of callees.flatMap((key) => functionsRunBy(db, call, key))) {
    for (const row of db.lookup("paramOf", 0, func)) {
      if (positional[Number(row[1])] === undefined) {
        omitted.push({ paramKey: String(row[2]), kind: "positional" });
      }
    }
    for (const row of db.lookup("paramNamed", 0, func)) {
      if (keyword[String(row[1])] === undefined) {
        omitted.push({ paramKey: String(row[2]), kind: "keyword" });
      }
    }
  }
  const byName = new Map<string, boolean>();
  for (const { paramKey, kind } of omitted) {
    for (const row of defaultReadsOf(db, paramKey)) {
      if (row[1] !== kind) {
        continue;
      }
      const name = String(row[2]);
      const defaulted = row[3] === 1;
      byName.set(name, (byName.get(name) ?? true) && defaulted);
    }
  }
  return [...byName].map(([name, defaulted]) => ({ name, defaulted }));
}

/**
 * The methods a call runs. `Klass.new` runs the `initialize` the class
 * writes, or the one it inherits when it writes none.
 */
function functionsRunBy(db: Database, call: RbNode, key: string): string[] {
  if (field(call, "method")?.text !== CONSTRUCTOR) {
    return resolvedFunctions(db, key);
  }
  return answersFor(db, "wantedObjectOf", key).flatMap((cls) =>
    constructorsOf(db, cls, 0),
  );
}

/** The deepest a superclass chain is followed, past what any project writes. */
const MAX_ANCESTORS = 32;

function constructorsOf(db: Database, cls: string, depth: number): string[] {
  const own = db.lookup("initializes", 0, cls).map((row) => String(row[1]));
  if (own.length > 0 || depth >= MAX_ANCESTORS) {
    return own;
  }
  const bases = db.lookup("extends", 0, cls).map((row) => String(row[1]));
  resolveValues(db, bases);
  return bases.flatMap((base) =>
    answersFor(db, "wantedComesTo", base).flatMap((ancestor) =>
      constructorsOf(db, ancestor, depth + 1),
    ),
  );
}

/**
 * Whether `ENV` is used for anything other than a read of a literal
 * variable name. A file whose reads all write out their variable passes
 * `ENV` nowhere, so the rules have nothing to follow.
 */
function handsOnward(node: RbNode): boolean {
  const parent = node.parent;
  if (parent === null) {
    return true;
  }
  if (parent.type === "element_reference" || parent.type === "call") {
    const spelling = envSpellingAt(parent);
    return spelling === null || stringLiteralValue(spelling.name) === null;
  }
  return true;
}

/**
 * The environment reads each of a body's calls reaches through a project
 * helper, or through a parameter default the call runs. The callees are
 * resolved in one round, so a body costs one question instead of one per
 * call. Which parameters name a variable was already settled once for
 * the whole run.
 */
function callReads(
  calls: readonly RbNode[],
  facts: EnvFacts,
  helpers: HelperFacts | null,
  defaults: boolean,
): NodeMap<EnvRead[]> {
  const { db, file } = facts;
  const callees = new NodeMap<string[]>();
  for (const call of calls) {
    const enclosing = enclosingDefinition(call);
    const keys = [
      calleeKeyOf(file, call, enclosing),
      invokedKeyOf(file, call, enclosing),
    ].filter((key): key is string => key !== null);
    if (keys.length > 0) {
      callees.set(call, keys);
    }
  }
  const reads = new NodeMap<EnvRead[]>();
  if (callees.size === 0) {
    return reads;
  }
  resolveValues(
    db,
    [...callees].flatMap(([, keys]) => keys),
  );

  for (const [call, callee] of callees) {
    const args =
      helpers === null ? [] : namingArguments(db, helpers.named, call, callee);
    const found = [
      ...(args.length === 0 ? [] : readsAtCall(db, call, args)),
      ...(defaults ? defaultReadsAtCall(db, call, callee) : []),
    ];
    if (found.length > 0) {
      reads.set(call, found);
    }
  }
  return reads;
}

/**
 * The arguments this call passes for parameters that name a variable,
 * across every function the callee settles on. A Ruby call is keyed both
 * as a method call and as an invocation of a value, so it comes with a
 * key for each.
 */
function namingArguments(
  db: Database,
  named: ReadonlyMap<string, readonly string[]>,
  call: RbNode,
  callees: readonly string[],
): NamingArgument[] {
  const { positional, keyword } = readCallArgs(field(call, "arguments"));
  const found: NamingArgument[] = [];
  for (const func of callees.flatMap((key) => resolvedFunctions(db, key))) {
    for (const row of db.lookup("paramOf", 0, func)) {
      const sites = sitesNamedBy(db, named, String(row[2]));
      const argument = positional[Number(row[1])];
      if (sites !== undefined && argument !== undefined) {
        found.push({ sites, argument });
      }
    }
    for (const row of db.lookup("paramNamed", 0, func)) {
      const sites = sitesNamedBy(db, named, String(row[2]));
      const argument = keyword[String(row[1])];
      if (sites !== undefined && argument !== undefined) {
        found.push({ sites, argument });
      }
    }
  }
  return found;
}

/**
 * The variables this call reads, reading each naming argument as a
 * string. One name read at two sites is one read, defaulted only where
 * every site supplies a fallback.
 */
function readsAtCall(
  db: Database,
  call: RbNode,
  args: readonly NamingArgument[],
): EnvRead[] {
  const defaultedAtCall = isDefaultedAt(call);
  const byName = new Map<string, boolean>();
  for (const { sites, argument } of args) {
    const name = stringLiteralValue(argument) ?? stringValueOf(argument, db);
    if (name === null) {
      continue;
    }
    for (const site of sites) {
      const defaulted =
        defaultedAtCall || db.lookup(ENV_DEFAULTED, 0, site).length > 0;
      byName.set(name, (byName.get(name) ?? true) && defaulted);
    }
  }
  return [...byName].map(([name, defaulted]) => ({ name, defaulted }));
}

function configReadEffect(read: EnvRead, at: RbNode): Effect {
  return {
    type: "interaction",
    binding: runtimeConfigBinding({ recognition: RUBY_ENV_RECOGNITION }),
    callee: read.name === null ? at.text : `ENV["${read.name}"]`,
    interaction: {
      class: "config-read",
      name: read.name,
      defaulted: read.defaulted,
      ...(read.fallback === undefined ? {} : { default: read.fallback }),
    },
    location: rangeOf(at),
  };
}

function envReadAt(
  node: RbNode,
  blankToNil: ReadonlySet<string> = NO_METHODS,
  db?: Database,
): EnvRead | null {
  const site = envSiteAt(node, blankToNil);
  if (site === null) {
    return null;
  }
  const fallback =
    site.defaulted && site.fallback !== null
      ? scalarOf(evaluatedValue(site.fallback, db))
      : null;
  return {
    name: stringLiteralValue(site.name),
    defaulted: site.defaulted,
    ...(fallback === null ? {} : { fallback }),
  };
}

function envSiteAt(
  node: RbNode,
  blankToNil: ReadonlySet<string>,
): EnvSite | null {
  const spelling = envSpellingAt(node);
  if (spelling === null) {
    return null;
  }
  return {
    read: node,
    name: spelling.name,
    defaulted: spelling.hasDefault || isDefaultedAt(node, spelling, blankToNil),
    fallback: spelling.fallback ?? fallbackOperandOf(node, blankToNil),
  };
}
