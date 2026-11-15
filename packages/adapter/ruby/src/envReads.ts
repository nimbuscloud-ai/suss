/**
 * What the environment chain needs from this adapter beyond its facts:
 * which parameters of a project helper end up as a variable's name, which
 * arguments a call passes them, which parameter defaults read a variable
 * and so run at the call that leaves the argument out, and whether the
 * program copes with a read coming back empty. The chain declares the
 * spellings, and the read dispatch hands it each site.
 *
 * Every expression that passes `ENV` somewhere becomes an
 * `environmentObject` fact. One question over those facts returns every
 * parameter whose value ends up naming a variable, so a body that calls
 * such a helper reports the read at the call. The seeds are found by
 * syntax, since they are stated before any constant is bound.
 */

import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";
import { readSpellingsOf } from "@suss/recognize";
import { valueKeyOf } from "@suss/recognize/ops";
import { answersFor, classMemberOf, noteLookup } from "@suss/resolution";

import {
  children,
  enclosingDefinition,
  field,
  NodeMap,
  readCallArgs,
  stringLiteralValue,
} from "./ast.js";
import { fallbackOperandOf, isDefaultedAt } from "./defaulted.js";
import {
  CONSTRUCTOR,
  INITIALIZE_METHOD,
  INVOKE_METHOD,
  SENDING_METHODS,
} from "./facts/languageWords.js";
import { parametersOf } from "./facts/locals.js";
import {
  resolvedFunctions,
  resolveEnvObjects,
  resolveValues,
} from "./facts/resolve.js";
import { calleeKeyOf, invokedKeyOf, nodeId, readKey } from "./facts/values.js";
import { ENVIRONMENT } from "./stdlib/environment.js";
import { environmentReadAt } from "./stdlib/environmentRead.js";
import { streamSpelledBy } from "./streamWrites.js";
import {
  boundFileOf,
  nodeOfResolutionKey,
  resolutionKeyOf,
} from "./values/evaluator.js";

import type { Database, Tuple } from "@suss/datalog";
import type { KeySupplied } from "@suss/extractor";
import type { GetterMeaning, SiteRead } from "@suss/recognize";
import type { RubyFactSource } from "./factSource.js";
import type { RbNode } from "./parser.js";

const SPELLINGS = readSpellingsOf(ENVIRONMENT.declared);

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
  helperNames(db);
}

/**
 * The same lookup a reader noted under `id`, made again in this run, or
 * null when `id` is not one of these.
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
  if (id === HELPER_NAMES) {
    return describeNames(helperNames(db));
  }
  return null;
}

const HELPER_NAMES = "envHelperNames";

const describeNames = (names: ReadonlySet<string>): string =>
  [...names].sort().join(",");

/** The answer, kept per run, since it covers every helper in the project. */
const helperNamesByDb = new WeakMap<Database, ReadonlySet<string>>();

/**
 * The names a call can come to a helper by. A helper is a method with a
 * parameter whose value becomes a variable's name, or with a default
 * that reads the environment. A call by any other name never runs one,
 * so the reader leaves its callee unresolved.
 */
function helperNames(db: Database): ReadonlySet<string> {
  const memo = helperNamesByDb.get(db);
  if (memo !== undefined) {
    return memo;
  }
  const parameters = new Set([
    ...namedParameters(db).keys(),
    ...db.facts(DEFAULT_READ).map((row) => String(row[0])),
  ]);
  const names = new Set<string>();
  for (const parameter of parameters) {
    for (const func of functionsTaking(db, parameter)) {
      for (const name of namesOfFunction(db, func)) {
        names.add(name);
      }
    }
  }
  if (names.has(INITIALIZE_METHOD)) {
    names.add(CONSTRUCTOR);
  }
  helperNamesByDb.set(db, names);
  return names;
}

/** The same names, noted so a later run can tell whether they changed. */
function notedHelperNames(db: Database): ReadonlySet<string> {
  const names = helperNames(db);
  noteLookup(db, HELPER_NAMES, describeNames(names));
  return names;
}

function functionsTaking(db: Database, parameter: string): string[] {
  return ["paramOf", "paramNamed"].flatMap((relation) =>
    db.lookup(relation, 2, parameter).map((row) => String(row[0])),
  );
}

/** The name a class stores a function under, and the name its `def` gives it. */
function namesOfFunction(db: Database, func: string): string[] {
  const held = db
    .lookup("holdsProperty", 2, func)
    .map((row) => String(row[1]))
    .map((name) => classMemberOf(name) ?? name);
  const node = nodeOfResolutionKey(func, db);
  const written =
    node === null || !METHOD_TYPES.has(node.type)
      ? null
      : (field(node, "name")?.text ?? null);
  return written === null ? held : [...held, written];
}

const METHOD_TYPES = new Set(["method", "singleton_method"]);

/**
 * Whether a call can come to a helper, by the name it is written with.
 * `call`, a send and a call written with no name can run a function of
 * any name.
 */
function mayRunHelper(call: RbNode, names: ReadonlySet<string>): boolean {
  const method = field(call, "method")?.text;
  return (
    method === undefined ||
    method === INVOKE_METHOD ||
    SENDING_METHODS.has(method) ||
    names.has(method)
  );
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

function blankToNilIn(db: Database): ReadonlySet<string> {
  const rows = db.facts(BLANK_TO_NIL);
  return rows.length === 0
    ? NO_METHODS
    : new Set(rows.map((row) => String(row[0])));
}

/** A parameter default whose reads are stated once the constants are bound. */
export interface WrittenDefault {
  readonly file: string;
  /** The parameter, keyed as the shared facts key it. */
  readonly parameter: string;
  readonly kind: DefaultKind;
  readonly value: RbNode;
}

/**
 * Records which expressions spell `ENV` and pass it on, so the shared
 * rules can work out which parameters a caller's argument ends up
 * naming. Returns the file's parameter defaults, whose reads the chain
 * says once every file's constants are bound.
 */
export function emitEnvFacts(
  db: Database,
  file: string,
  root: RbNode,
): WrittenDefault[] {
  const defaults: WrittenDefault[] = [];
  walkDescendants<RbNode, null>(root, null, children, {
    at: (node) => {
      if (DEFAULTED_PARAMETER_HOLDERS.has(node.type)) {
        defaults.push(...defaultsOf(file, node));
      }
      if (spellsObject(node) && handsOnward(node)) {
        db.add("environmentObject", [
          readKey(file, node, enclosingDefinition(node)),
        ]);
      }
      if (streamSpelledBy(node) !== null && !writtenThrough(node)) {
        db.add("streamObject", [
          readKey(file, node, enclosingDefinition(node)),
        ]);
      }
    },
    into: () => null,
  });
  return defaults;
}

/**
 * Whether the node is spelled as one of the chain's paths, `ENV` or
 * `::ENV`, each a constant at the top level. The seeds are found before
 * the constants are bound, so this reads the syntax.
 */
function spellsObject(node: RbNode): boolean {
  if (node.type === "constant") {
    return SPELLINGS.paths.includes(node.text);
  }
  return (
    node.type === "scope_resolution" &&
    field(node, "scope") === null &&
    SPELLINGS.paths.includes(field(node, "name")?.text ?? "")
  );
}

/**
 * Whether `ENV` is used for anything other than a read of a literal
 * variable name. A file whose reads all write out their variable passes
 * `ENV` nowhere, so the rules have nothing to follow.
 */
function handsOnward(node: RbNode): boolean {
  const parent = node.parent;
  if (
    parent?.type === "element_reference" &&
    field(parent, "object")?.id === node.id
  ) {
    const index = children(parent).find((child) => child.id !== node.id);
    return isAssignedTo(parent) || !writesTheKey(index);
  }
  if (parent?.type === "call" && field(parent, "receiver")?.id === node.id) {
    const getter = getterCalled(parent);
    return getter === undefined || !writesTheKey(keyArgumentOf(parent, getter));
  }
  return true;
}

/** `ENV["X"] = v` and `ENV["X"] ||= v` change the environment rather than reading it. */
function isAssignedTo(node: RbNode): boolean {
  const parent = node.parent;
  return (
    parent !== null &&
    (parent.type === "assignment" || parent.type === "operator_assignment") &&
    field(parent, "left")?.id === node.id
  );
}

/** Whether the source spells the variable at this read rather than working it out. */
const writesTheKey = (key: RbNode | undefined): boolean =>
  key !== undefined && stringLiteralValue(key) !== null;

/** The chain's getter a call sends, `fetch` in `ENV.fetch("X")`. */
function getterCalled(call: RbNode): GetterMeaning | undefined {
  const method = field(call, "method")?.text ?? "";
  return Object.hasOwn(SPELLINGS.getters, method)
    ? SPELLINGS.getters[method]
    : undefined;
}

/** The argument a getter call passes its key at. */
function keyArgumentOf(
  call: RbNode,
  getter: GetterMeaning,
): RbNode | undefined {
  return readCallArgs(field(call, "arguments")).positional[getter.key.at];
}

/** `$stdout.puts x` writes to the stream it spells, and hands the stream to nobody. */
function writtenThrough(node: RbNode): boolean {
  const parent = node.parent;
  return parent?.type === "call" && field(parent, "receiver")?.id === node.id;
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

type DefaultKind = "positional" | "keyword";

const DEFAULT_KIND: Record<string, DefaultKind> = {
  optional_parameter: "positional",
  keyword_parameter: "keyword",
};

/** Whether any parameter default in the run reads the environment, noted so a later run can tell whether that changed. */
export function hasDefaultReads(db: Database): boolean {
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

function defaultsOf(file: string, method: RbNode): WrittenDefault[] {
  const funcKey = nodeId(file, method);
  return parametersOf(method).flatMap((param) => {
    const kind = DEFAULT_KIND[param.type];
    const name = field(param, "name");
    const value = field(param, "value");
    return kind === undefined || name === null || value === null
      ? []
      : [{ file, parameter: `${funcKey}#${name.text}`, kind, value }];
  });
}

/**
 * States the reads in each parameter default, as the environment chain
 * reads them, once the constants they read are bound. The read's text
 * goes in the row too, so a replayed caller notices a fallback edited in
 * place, which keeps the read's range.
 */
export function emitDefaultReadFacts(
  source: RubyFactSource,
  defaults: readonly WrittenDefault[],
): void {
  for (const { file, parameter, kind, value } of defaults) {
    for (const read of namedReadsUnder(value, source)) {
      source.db.add(DEFAULT_READ, [
        parameter,
        kind,
        read.name,
        read.defaulted ? 1 : 0,
        nodeId(file, read.at),
        read.at.text,
      ]);
    }
  }
}

/** A read in a parameter default that writes out its variable. */
interface DefaultRead {
  readonly name: string;
  readonly defaulted: boolean;
  readonly at: RbNode;
}

/** A method or a lambda written in a default runs when it is called, not when the default does. */
const DEFERRED_BODY_TYPES = new Set(["method", "singleton_method", "lambda"]);

/** The reads under a node that write out their variable, the node itself included. */
function namedReadsUnder(node: RbNode, source: RubyFactSource): DefaultRead[] {
  const reads: DefaultRead[] = [];
  const take = (at: RbNode): void => {
    const site = environmentReadAt(at, source);
    const name = site?.entry ?? null;
    if (site !== null && name !== null && name !== "") {
      reads.push({
        name,
        defaulted: copingWith(at, site, source).defaulted,
        at,
      });
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

/** Whether a node is the default of one of `root`'s own parameters, which runs at the call and not in the body. */
export function isOwnParameter(node: RbNode, root: RbNode): boolean {
  return (
    DEFAULT_KIND[node.type] !== undefined && node.parent?.parent?.id === root.id
  );
}

/** A variable the defaults a call runs read, and the first of its sites. */
export interface DefaultReadAtCall {
  readonly name: string;
  /** Whether every default that reads it copes with a missing value. */
  readonly defaulted: boolean;
  readonly site: string;
}

/**
 * The variables read in the defaults a call runs: those of the
 * parameters it passes nothing for, across every method the callee
 * settles on, one per variable in the order they first appear.
 */
export function defaultReadsAtCall(
  db: Database,
  call: RbNode,
  callees: readonly string[],
): DefaultReadAtCall[] {
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
  const byName = new Map<string, { defaulted: boolean; site: string }>();
  for (const { paramKey, kind } of omitted) {
    for (const row of defaultReadsOf(db, paramKey)) {
      if (row[1] !== kind) {
        continue;
      }
      const name = String(row[2]);
      const known = byName.get(name);
      byName.set(name, {
        defaulted: (known?.defaulted ?? true) && row[3] === 1,
        site: known?.site ?? String(row[4]),
      });
    }
  }
  return [...byName].map(([name, { defaulted, site }]) => ({
    name,
    defaulted,
    site,
  }));
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
 * The keys the facts give the functions a call can run: the method it
 * sends, and the value it invokes when it is `f.call(x)` or `f.(x)`. A
 * Ruby call is keyed both ways, so it comes with a key for each.
 */
function calleeKeysOf(call: RbNode): string[] {
  const file = boundFileOf(call);
  if (file === undefined) {
    return [];
  }
  const enclosing = enclosingDefinition(call);
  return [
    calleeKeyOf(file, call, enclosing),
    invokedKeyOf(file, call, enclosing),
  ].filter((key): key is string => key !== null);
}

/**
 * Asks which functions the calls of one body come to, in one round, and
 * returns each call's callee keys, so a call asked which keys it supplies
 * or which defaults it runs has its answer already. Without a parameter
 * that names a variable or a default that reads one, it asks nothing.
 */
export function calleesOfCalls(
  db: Database,
  calls: readonly RbNode[],
  defaults: boolean,
): NodeMap<string[]> {
  const callees = new NodeMap<string[]>();
  if (calls.length === 0 || (!defaults && namedParameters(db).size === 0)) {
    return callees;
  }
  const names = notedHelperNames(db);
  for (const call of calls) {
    if (!mayRunHelper(call, names)) {
      continue;
    }
    const keys = calleeKeysOf(call);
    if (keys.length > 0) {
      callees.set(call, keys);
    }
  }
  if (callees.size > 0) {
    resolveValues(
      db,
      [...callees].flatMap(([, keys]) => keys),
    );
  }
  return callees;
}

/**
 * The arguments of the call at the key whose value becomes a read's key
 * down the callee, by position or by keyword, across every function the
 * callee settles on. The value is keyed on the argument as written, so
 * the evaluator reads it the way it reads any argument, and a parameter
 * the caller passes on settles through the calls that reach the caller.
 */
export function keysSuppliedAt(
  source: RubyFactSource,
  call: string,
): KeySupplied[] {
  const { db } = source;
  if (db.lookup("call", 0, call).length === 0) {
    return [];
  }
  const named = namedParameters(db);
  noteLookup(db, NAMED_ANY, describeAny(named));
  const node = named.size === 0 ? null : nodeOfResolutionKey(call, db);
  const file = node === null ? undefined : boundFileOf(node);
  if (
    node === null ||
    node.type !== "call" ||
    file === undefined ||
    !mayRunHelper(node, notedHelperNames(db))
  ) {
    return [];
  }
  const callees = calleeKeysOf(node);
  resolveValues(db, callees);
  return namingArguments(db, named, node, callees).map((naming) => ({
    at: naming.at,
    ...(naming.keyword === undefined ? {} : { keyword: naming.keyword }),
    value: nodeId(file, naming.argument),
    forwarded: false,
    sites: naming.sites,
  }));
}

/** What a caller passes for a parameter the rules found. */
interface NamingArgument {
  /** The reads the parameter's value supplies the name to. */
  readonly sites: readonly string[];
  readonly argument: RbNode;
  /** The position the call passes it at, or -1 for a keyword argument. */
  readonly at: number;
  readonly keyword?: string;
}

/** The arguments this call passes for parameters that name a variable, across every function the callee settles on. */
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
      const at = Number(row[1]);
      const argument = positional[at];
      if (sites !== undefined && argument !== undefined) {
        found.push({ sites, argument, at });
      }
    }
    for (const row of db.lookup("paramNamed", 0, func)) {
      const sites = sitesNamedBy(db, named, String(row[2]));
      const name = String(row[1]);
      const argument = keyword[name];
      if (sites !== undefined && argument !== undefined) {
        found.push({ sites, argument, at: -1, keyword: name });
      }
    }
  }
  return found;
}

/**
 * Whether a read copes with its value coming back empty, and the key of
 * the value it falls back to, decided the way the environment chain
 * reads an environment read and by the plain rule for any other read.
 */
export function copingAt(
  node: RbNode,
  source: RubyFactSource,
): { defaulted: boolean; fallback: string | null } {
  return copingWith(node, environmentReadAt(node, source), source);
}

function copingWith(
  node: RbNode,
  site: SiteRead | null,
  source: RubyFactSource,
): { defaulted: boolean; fallback: string | null } {
  const blankToNil = blankToNilIn(source.db);
  const fallback = fallbackKeyOf(node, site, blankToNil);
  if (site === null) {
    return { defaulted: isDefaultedAt(node, undefined, blankToNil), fallback };
  }
  return {
    defaulted:
      site.passesFallback || isDefaultedAt(node, { site, source }, blankToNil),
    fallback,
  };
}

/** What a getter call passes as its fallback, or else what an `||` around the read supplies. */
function fallbackKeyOf(
  node: RbNode,
  site: SiteRead | null,
  blankToNil: ReadonlySet<string>,
): string | null {
  if (site !== null && site.fallback !== null) {
    return valueKeyOf(site.fallback);
  }
  const operand = fallbackOperandOf(node, blankToNil);
  return operand === null ? null : resolutionKeyOf(operand);
}
