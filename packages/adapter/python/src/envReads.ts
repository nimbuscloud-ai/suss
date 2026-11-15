/**
 * What the environment chain needs from this adapter beyond its facts:
 * which parameters of a project helper end up as a variable's name, which
 * arguments a call passes them, and whether the program copes with a read
 * coming back empty. The chain declares the spellings, and the read
 * dispatch hands it each site.
 *
 * Each expression that hands `os.environ` or `os.getenv` somewhere is
 * recorded as `environmentObject`, the value facts record the read, and
 * one question keyed on those objects returns the parameters that end up
 * as a variable's name. The seeds are found by syntax, since they are
 * stated before any facts exist. DESIGN.md lists the spellings.
 */

import { walkDescendants } from "@suss/extractor";
import { readSpellingsOf } from "@suss/recognize";
import { valueKeyOf } from "@suss/recognize/ops";
import { isObserved, noteLookup } from "@suss/resolution";

import {
  children,
  enclosingFunction,
  field,
  parameterIdentifier,
  stringLiteralValue,
} from "./ast.js";
import { fallbackOperandOf, isDefaultedAt } from "./defaulted.js";
import {
  resolveCalls,
  resolvedFunctions,
  resolveEnvObjects,
} from "./facts/resolve.js";
import { callArguments, nodeId, readKey } from "./facts/values.js";
import { ENVIRONMENT } from "./stdlib/environment.js";
import { environmentReadAt } from "./stdlib/environmentRead.js";
import { spellsStdlibPath } from "./stdlibNames.js";
import { standardStream } from "./streamWrites.js";
import { nodeOfResolutionKey, resolutionKeyOf } from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type { KeySupplied } from "@suss/extractor";
import type { GetterMeaning, SiteRead } from "@suss/recognize";
import type { PythonFactSource } from "./factSource.js";
import type { PyNode } from "./parser.js";
import type { ModuleBinding, Scope } from "./scope.js";

const SPELLINGS = readSpellingsOf(ENVIRONMENT.declared);

/**
 * Whether a read copes with its value coming back empty, and the key of
 * the value it falls back to, decided the way the environment chain
 * reads an environment read and by the plain rule for any other read.
 */
export function copingAt(
  node: PyNode,
  source: PythonFactSource,
): { defaulted: boolean; fallback: string | null } {
  const site = environmentReadAt(node, source);
  const fallback = fallbackKeyOf(node, site, source);
  if (site === null) {
    return { defaulted: isDefaultedAt(node), fallback };
  }
  return {
    defaulted: site.passesFallback || isDefaultedAt(node, { site, source }),
    fallback,
  };
}

/** What a getter call passes as its fallback, or else what an `or` around the read supplies. */
function fallbackKeyOf(
  node: PyNode,
  site: SiteRead | null,
  source: PythonFactSource,
): string | null {
  if (site !== null && site.fallback !== null) {
    return valueKeyOf(site.fallback);
  }
  const operand = fallbackOperandOf(node);
  return operand === null ? null : resolutionKeyOf(operand, source.db);
}

/**
 * A read through a function getter whose key the program works out,
 * `os.getenv(name)`. The value facts state a keyed read off a container,
 * and a function call has none, so this states one off the function.
 */
interface FunctionRead {
  site: string;
  /** The function getter the read goes through, which seeds the rules like the object does. */
  functionKey: string;
  /** The key of the expression the name comes from, which the rules join to a parameter. */
  nameKey: string;
}

/** What one file says about the environment, for the shared rules. */
export interface EnvFileFacts {
  /** Keys of the expressions that spell the environment and hand it on. */
  objects: string[];
  functionReads: FunctionRead[];
  /** Keys of the expressions that spell `sys.stdout` or `sys.stderr` and hand it on. */
  streams: string[];
}

/**
 * What a file does with the environment: every expression that passes
 * the object somewhere, and every function getter whose key it works
 * out. This walk goes into function bodies, where a unit's own reads
 * stop, because a helper's own read is written inside one.
 */
export function envFactsIn(
  filePath: string,
  root: PyNode,
  module: ModuleBinding,
): EnvFileFacts {
  const found: EnvFileFacts = { objects: [], functionReads: [], streams: [] };
  walkDescendants<PyNode, Scope>(root, module.moduleScope, children, {
    at: (node, scope) => {
      if (spellsObject(node, scope) && handsOnward(node)) {
        found.objects.push(keyOf(filePath, node));
      }
      if (spellsStream(node, scope) && !writtenThrough(node)) {
        found.streams.push(keyOf(filePath, node));
      }
      const read = functionReadAt(filePath, node, scope);
      if (read !== null) {
        found.functionReads.push(read);
      }
    },
    into: (node, scope) => module.scopeFor.get(node.id) ?? scope,
  });
  return found;
}

/** The key the value facts give an expression, so the rules join on one key. */
const keyOf = (filePath: string, node: PyNode): string =>
  readKey(filePath, node, enclosingFunction(node));

function spellsObject(node: PyNode, scope: Scope): boolean {
  return SPELLINGS.paths.some((path) => spellsStdlibPath(node, scope, path));
}

/** `os.getenv(name)`, a call of one of the chain's functions with a key the source doesn't write out. */
function functionReadAt(
  filePath: string,
  node: PyNode,
  scope: Scope,
): FunctionRead | null {
  const callee = node.type === "call" ? field(node, "function") : null;
  if (callee === null) {
    return null;
  }
  const getter = Object.entries(SPELLINGS.functions).find(([path]) =>
    spellsStdlibPath(callee, scope, path),
  )?.[1];
  const key = getter === undefined ? null : keyArgumentOf(node, getter);
  if (key === null || writesTheKey(key)) {
    return null;
  }
  return {
    site: nodeId(filePath, node),
    functionKey: keyOf(filePath, callee),
    nameKey: keyOf(filePath, key),
  };
}

/**
 * Whether anything but a read of one written-out variable is done with
 * the object. A file whose every read spells its own variable hands the
 * environment nowhere, so the rules have nothing to follow out of it.
 */
function handsOnward(node: PyNode): boolean {
  const parent = node.parent;
  if (parent === null) {
    return true;
  }
  if (parent.type === "subscript" && field(parent, "value")?.id === node.id) {
    return !writesTheKey(field(parent, "subscript"));
  }
  if (parent.type === "attribute" && field(parent, "object")?.id === node.id) {
    const call = parent.parent;
    const method = field(parent, "attribute")?.text ?? "";
    const getter = Object.hasOwn(SPELLINGS.getters, method)
      ? SPELLINGS.getters[method]
      : undefined;
    return (
      getter !== undefined &&
      call !== null &&
      call.type === "call" &&
      !writesTheKey(keyArgumentOf(call, getter))
    );
  }
  return true;
}

/** `sys.stdout` as the source spells it. The `stdout` inside that spelling is only its name. */
function spellsStream(node: PyNode, scope: Scope): boolean {
  const parent = node.parent;
  const attributeName =
    parent?.type === "attribute" && field(parent, "attribute")?.id === node.id;
  return !attributeName && standardStream(node, scope) !== null;
}

/** `sys.stdout.write(x)` writes to the stream it spells, and hands the stream to nobody. */
function writtenThrough(node: PyNode): boolean {
  const parent = node.parent;
  return (
    parent?.type === "attribute" && field(parent, "object")?.id === node.id
  );
}

/** Whether the source spells the variable at this read rather than working it out. */
const writesTheKey = (key: PyNode | null): boolean =>
  key !== null && stringLiteralValue(key) !== null;

/** The argument a getter call passes its key at. */
function keyArgumentOf(call: PyNode, getter: GetterMeaning): PyNode | null {
  const key = callArguments(call).find(
    (argument) =>
      argument.kind === "positional" && argument.position === getter.key.at,
  );
  return key?.node ?? null;
}

/** What one run recorded about the environment before the rules are asked. */
interface EnvSiteIndex {
  /** Every expression recorded as the environment. The rules are seeded with these. */
  objects: Set<string>;
  /** For each parameter, the sites whose variable name it ends up as. Null until the rules have been asked. */
  sitesByParameter: Map<string, string[]> | null;
}

const sitesByDb = new WeakMap<Database, EnvSiteIndex>();

/**
 * Adds the files' environment facts to the database, and keeps the
 * objects the rules are seeded with, so a call can ask whether one of
 * its callee's parameters is a variable's name.
 */
export function bindEnvFacts(
  db: Database,
  found: readonly EnvFileFacts[],
): void {
  const objects = found.flatMap((one) => one.objects);
  const functionReads = found.flatMap((one) => one.functionReads);
  for (const stream of found.flatMap((one) => one.streams)) {
    db.add("streamObject", [stream]);
  }
  if (functionReads.length === 0 && objects.length === 0) {
    return;
  }
  let index = sitesByDb.get(db);
  if (index === undefined) {
    index = { objects: new Set(), sitesByParameter: null };
    sitesByDb.set(db, index);
  }
  for (const object of objects) {
    db.add("environmentObject", [object]);
    index.objects.add(object);
  }
  for (const read of functionReads) {
    db.add("environmentObject", [read.functionKey]);
    db.add("readsKeyed", [read.site, read.functionKey, read.nameKey]);
    index.objects.add(read.functionKey);
  }
}

/**
 * For each parameter, the sites whose variable name it ends up as, from
 * one question over every expression recorded as the environment. It is
 * asked the first time a call is, when every file's facts are in the
 * database. The question is seeded with objects instead of reads,
 * because a read through a parameter is taken off an object that no scan
 * of the source would pick out.
 */
function sitesEachParameterNames(
  db: Database,
  index: EnvSiteIndex,
): ReadonlyMap<string, string[]> {
  if (index.sitesByParameter !== null) {
    return index.sitesByParameter;
  }
  resolveEnvObjects(db, [...index.objects]);
  const found = new Map<string, string[]>();
  for (const row of db.facts("wantedParamNamesEnv")) {
    const site = String(row[1]);
    // `os.environ[name] = value` sets the variable, so a helper that only
    // sets the one it is handed reads nothing.
    if (db.lookup("assigns", 0, site).length > 0) {
      continue;
    }
    const parameter = String(row[0]);
    const named = found.get(parameter) ?? [];
    named.push(site);
    found.set(parameter, named);
  }
  index.sitesByParameter = found;
  return found;
}

const NAMED_ANY = "envNamedAny";
const NAMED_PARAMETER = "envNamed ";

/**
 * The sites a parameter names, each marked when the program copes with
 * it coming back empty, since a call's read is defaulted only when every
 * site is.
 */
function describeSites(
  sites: readonly string[] | undefined,
  source: PythonFactSource,
): string {
  return sites === undefined
    ? "-"
    : sites.map((id) => `${id}${siteCopes(id, source) ? "!" : ""}`).join(",");
}

function siteCopes(id: string, source: PythonFactSource): boolean {
  const node = nodeOfResolutionKey(id, source.db);
  return node !== null && copingAt(node, source).defaulted;
}

/**
 * Asks the run's one question about which parameters name a variable,
 * so it is answered before any file's work starts and no one file is
 * charged for every file's reads.
 */
export function settleNamedParameters(db: Database): void {
  const index = sitesByDb.get(db);
  if (index !== undefined) {
    sitesEachParameterNames(db, index);
  }
}

/**
 * The same lookup a reader noted under `id`, made again in this run, or
 * null when `id` is not one of these.
 */
export function envLookupAgain(
  source: PythonFactSource,
  id: string,
): string | null {
  const index = sitesByDb.get(source.db);
  const named =
    index === undefined
      ? new Map<string, string[]>()
      : sitesEachParameterNames(source.db, index);
  if (id === NAMED_ANY) {
    return named.size === 0 ? "none" : "some";
  }
  if (id.startsWith(NAMED_PARAMETER)) {
    return describeSites(named.get(id.slice(NAMED_PARAMETER.length)), source);
  }
  return null;
}

/**
 * Asks which functions the calls of one body come to, in one round, so a
 * call asked which keys it supplies has its answer already. Without any
 * parameter that names a variable it asks nothing.
 */
export function resolveHelperCallees(
  db: Database,
  calls: readonly PyNode[],
): void {
  const index = sitesByDb.get(db);
  if (
    index === undefined ||
    calls.length === 0 ||
    sitesEachParameterNames(db, index).size === 0
  ) {
    return;
  }
  const keys = new Set(
    calls.flatMap((call) => {
      const key = calleeKeyOf(call, db);
      return key === null ? [] : [key];
    }),
  );
  if (keys.size > 0) {
    resolveCalls(db, [...keys]);
  }
}

function calleeKeyOf(call: PyNode, db: Database): string | null {
  const callee = field(call, "function");
  return callee === null ? null : resolutionKeyOf(callee, db);
}

/**
 * The arguments of the call at the key whose value becomes a read's key
 * down the callee, by position or by keyword, across every function the
 * callee resolves to. An argument that is the caller's own parameter is
 * forwarded, and the read belongs to whoever calls the caller.
 */
export function keysSuppliedAt(
  source: PythonFactSource,
  call: string,
): KeySupplied[] {
  const { db } = source;
  const index = sitesByDb.get(db);
  if (index === undefined || db.lookup("call", 0, call).length === 0) {
    return [];
  }
  const node = nodeOfResolutionKey(call, db);
  if (node === null) {
    return [];
  }
  const named = sitesEachParameterNames(db, index);
  noteLookup(db, NAMED_ANY, named.size === 0 ? "none" : "some");
  const calleeKey = named.size === 0 ? null : calleeKeyOf(node, db);
  if (calleeKey === null) {
    return [];
  }
  resolveCalls(db, [calleeKey]);
  return argumentsByParameter(db, node, calleeKey).flatMap(
    ({ parameter, argument }) => {
      const sites = named.get(parameter);
      if (isObserved(db)) {
        noteLookup(
          db,
          `${NAMED_PARAMETER}${parameter}`,
          describeSites(sites, source),
        );
      }
      const value = resolutionKeyOf(argument.node, db);
      if (sites === undefined || value === null) {
        return [];
      }
      return [
        {
          at: argument.kind === "positional" ? argument.position : -1,
          ...(argument.kind === "keyword" ? { keyword: argument.name } : {}),
          value,
          forwarded: handsOnParameter(argument.node),
          sites,
        },
      ];
    },
  );
}

type WrittenArgument = ReturnType<typeof callArguments>[number];

/**
 * The argument this call writes at each of the callee's parameters, by
 * the parameter's key. A parameter the call writes nothing at is left
 * out, and so is a callee nothing in the run resolves.
 */
function argumentsByParameter(
  db: Database,
  call: PyNode,
  calleeKey: string,
): { parameter: string; argument: WrittenArgument }[] {
  const written = callArguments(call);
  if (written.length === 0) {
    return [];
  }
  const positional = new Map<string, WrittenArgument>();
  const byName = new Map<string, WrittenArgument>();
  for (const argument of written) {
    if (argument.kind === "keyword") {
      byName.set(argument.name, argument);
      continue;
    }
    positional.set(String(argument.position), argument);
  }

  const argumentAt = new Map<string, WrittenArgument>();
  for (const callee of resolvedFunctions(db, calleeKey)) {
    for (const row of db.lookup("paramOf", 0, callee)) {
      const at = positional.get(String(row[1]));
      if (at !== undefined) {
        argumentAt.set(String(row[2]), at);
      }
    }
    for (const row of db.lookup("paramNamed", 0, callee)) {
      const at = byName.get(String(row[1]));
      if (at !== undefined) {
        argumentAt.set(String(row[2]), at);
      }
    }
  }
  return [...argumentAt].map(([parameter, argument]) => ({
    parameter,
    argument,
  }));
}

/**
 * Whether the argument is the calling function's own parameter, as in
 * `get_env(key)` calling `require_env(key)`. The name comes from whoever
 * calls `get_env`, and the rules follow it to that call, so the
 * forwarding call records nothing. Settling the parameter here would
 * give the helper its callers' names.
 */
function handsOnParameter(argument: PyNode): boolean {
  const caller = enclosingFunction(argument);
  if (argument.type !== "identifier" || caller === null) {
    return false;
  }
  return children(field(caller, "parameters")).some(
    (param) => parameterIdentifier(param)?.text === argument.text,
  );
}
