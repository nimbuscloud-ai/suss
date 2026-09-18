/**
 * envReads.ts: the environment variables a body reads, whether through
 * the standard library itself or through a project helper.
 * `os.environ["X"]`, `os.environ.get("X", d)` and `os.getenv("X", d)`
 * become the config-read effect the TypeScript adapter emits for
 * `process.env.X`, with the same defaulted flag, so the runtime-config
 * checker pairs them against a template the same way.
 *
 * `os` is the language's own module, so this belongs to the adapter and
 * not to a pack. A read whose name is a parameter states
 * `readsEnvNamed`; one question keyed on those sites gives back the
 * parameters that end up as a variable's name, and a reader at a call
 * reads the argument only at one of those. The README lists the spellings.
 */

import { runtimeConfigBinding } from "@suss/behavioral-ir";
import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

import { enclosingFunction, field, stringLiteralValue } from "./ast.js";
import {
  resolveCalls,
  resolvedFunctions,
  resolveEnvSites,
} from "./facts/resolve.js";
import { callArguments, nodeId, readKey } from "./facts/values.js";
import { resolveName } from "./scope.js";
import { resolutionKeyOf, stringValueOf } from "./values/evaluator.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { PyNode } from "./parser.js";
import type { ModuleBinding, Scope } from "./scope.js";

export const PYTHON_ENV_RECOGNITION = "python-env";

interface EnvRead {
  name: string;
  defaulted: boolean;
}

/** A read of the environment, before anything is settled about the variable's name. */
interface EnvReadSyntax {
  /** The expression the variable's name comes from. */
  name: PyNode;
  defaulted: boolean;
}

/** A nested function's reads happen when it is called, so its body waits for its own unit. */
const DEFERRED_BODY_TYPES = new Set(["function_definition", "lambda"]);

/** One place in a body: a read the body writes itself, or a call that may read through a helper. */
type ReadSlot = { read: EnvRead } | { call: PyNode };

/**
 * The config-read effects for every environment read under `root`,
 * in source order. `root` itself is not read: pass the unit's function
 * for its body, or the module node for what runs at import time.
 *
 * With `facts`, a call to a project helper that reads the environment
 * through one of its parameters is read too, at the call.
 */
export function envReadEffects(
  root: PyNode,
  module: ModuleBinding,
  facts?: Database,
): Effect[] {
  const slots: ReadSlot[] = [];
  // A run that stated no site has no helper to find behind a call, so
  // the calls are not collected at all.
  const readsHelpers = facts !== undefined && sitesByDb.has(facts);
  const startScope = module.scopeFor.get(root.id) ?? module.moduleScope;
  walkDescendants<PyNode, Scope>(root, startScope, {
    at: (node, scope) => {
      const syntax = envReadSyntaxAt(node, scope);
      if (syntax !== null) {
        const name = stringLiteralValue(syntax.name);
        if (name !== null) {
          slots.push({ read: { name, defaulted: syntax.defaulted } });
        }
        return;
      }
      if (readsHelpers && node.type === "call") {
        slots.push({ call: node });
      }
    },
    into: (node, scope) => {
      if (DEFERRED_BODY_TYPES.has(node.type)) {
        return SKIP_CHILDREN;
      }
      return module.scopeFor.get(node.id) ?? scope;
    },
  });

  const throughHelpers = helperReadsByCall(
    slots.flatMap((slot) => ("call" in slot ? [slot.call] : [])),
    facts,
  );
  return slots.flatMap((slot) => {
    if ("read" in slot) {
      return [configReadEffect(slot.read)];
    }
    return throughHelpers.get(slot.call.id) ?? [];
  });
}

function configReadEffect(read: EnvRead): Effect {
  return {
    type: "interaction",
    binding: runtimeConfigBinding({
      recognition: PYTHON_ENV_RECOGNITION,
      deploymentTarget: "lambda",
      instanceName: "<unknown>",
    }),
    callee: `os.environ["${read.name}"]`,
    interaction: {
      class: "config-read",
      name: read.name,
      defaulted: read.defaulted,
    },
  };
}

function envReadSyntaxAt(node: PyNode, scope: Scope): EnvReadSyntax | null {
  if (node.type === "subscript") {
    return subscriptRead(node, scope);
  }
  if (node.type === "call") {
    return callRead(node, scope);
  }
  return null;
}

/** `os.environ["X"]`, which raises when the variable is unset unless an `or` supplies a fallback. */
function subscriptRead(node: PyNode, scope: Scope): EnvReadSyntax | null {
  const value = field(node, "value");
  const index = field(node, "subscript");
  if (value === null || index === null || !isEnviron(value, scope)) {
    return null;
  }
  if (isAssignedTo(node)) {
    return null;
  }
  return { name: index, defaulted: isDefaultedAt(node) };
}

/** `os.environ["X"] = v` and `del os.environ["X"]` change the environment rather than read it. */
function isAssignedTo(node: PyNode): boolean {
  const parent = node.parent;
  if (parent === null) {
    return false;
  }
  if (parent.type === "delete_statement") {
    return true;
  }
  return (
    (parent.type === "assignment" || parent.type === "augmented_assignment") &&
    field(parent, "left")?.id === node.id
  );
}

/** `os.environ.get("X", d)` and `os.getenv("X", d)`, defaulted when a second argument is passed. */
function callRead(node: PyNode, scope: Scope): EnvReadSyntax | null {
  const callee = field(node, "function");
  if (callee === null || !isEnvGetter(callee, scope)) {
    return null;
  }
  const written = callArguments(node);
  const name = written.find(
    (argument) => argument.kind === "positional" && argument.position === 0,
  );
  if (name === undefined) {
    return null;
  }
  const hasDefault = written.some(
    (argument) =>
      (argument.kind === "positional" && argument.position === 1) ||
      (argument.kind === "keyword" && argument.name === "default"),
  );
  return { name: name.node, defaulted: hasDefault || isDefaultedAt(node) };
}

/** `os.environ.get` or `os.getenv`, through whatever name the file imported them under. */
function isEnvGetter(callee: PyNode, scope: Scope): boolean {
  if (callee.type === "attribute") {
    const object = field(callee, "object");
    const attribute = field(callee, "attribute")?.text;
    if (object === null) {
      return false;
    }
    if (attribute === "get") {
      return isEnviron(object, scope);
    }
    return attribute === "getenv" && isOsModule(object, scope);
  }
  return isImportedFromOs(callee, scope, "getenv");
}

/** `os.environ`, or `environ` after `from os import environ`. */
function isEnviron(node: PyNode, scope: Scope): boolean {
  if (node.type === "attribute") {
    const object = field(node, "object");
    return (
      object !== null &&
      field(node, "attribute")?.text === "environ" &&
      isOsModule(object, scope)
    );
  }
  return isImportedFromOs(node, scope, "environ");
}

function isOsModule(node: PyNode, scope: Scope): boolean {
  if (node.type !== "identifier") {
    return false;
  }
  const binding = resolveName(scope, node.text);
  return (
    binding?.kind === "import" &&
    binding.module === "os" &&
    binding.relativeLevel === 0
  );
}

function isImportedFromOs(node: PyNode, scope: Scope, name: string): boolean {
  if (node.type !== "identifier") {
    return false;
  }
  const binding = resolveName(scope, node.text);
  return (
    binding?.kind === "importFrom" &&
    binding.module === "os" &&
    binding.relativeLevel === 0 &&
    binding.importedName === name
  );
}

/**
 * Whether an `or` supplies a value when this read comes back empty. The
 * climb continues through a chain, so B in `A or B or "d"` counts, and
 * stops where the read is the final operand and is itself the fallback.
 */
function isDefaultedAt(node: PyNode): boolean {
  let child = node;
  let parent = node.parent;
  while (parent !== null) {
    if (parent.type === "parenthesized_expression") {
      child = parent;
      parent = parent.parent;
      continue;
    }
    if (
      parent.type !== "boolean_operator" ||
      field(parent, "operator")?.text !== "or"
    ) {
      return false;
    }
    if (field(parent, "left")?.id === child.id) {
      return true;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/**
 * A read whose variable name the source does not write out: the site
 * the shared rules land on, and what a reader reports when it lands
 * there.
 */
export interface EnvNameSite {
  /** The read expression, keyed the way the value facts key a node. */
  site: string;
  /** The key of the expression the name comes from, which the rules join to a parameter. */
  nameKey: string;
  defaulted: boolean;
  /**
   * The environment reference a read written as a call goes through.
   * The value facts state the container of `os.environ[name]`;
   * `os.getenv(name)` has no container for them to state.
   */
  functionKey: string | null;
}

/** What one file says about the environment, for the shared rules. */
export interface EnvFileFacts {
  sites: EnvNameSite[];
  /** Keys of the expressions that spell the environment and hand it on. */
  objects: string[];
}

/**
 * What a file says about the environment: every read whose variable
 * name is not a string literal, and every expression that spells the
 * environment object and hands it somewhere. Function bodies are
 * included, since a helper's own read is written in one, which is why
 * this walk does not stop where `envReadEffects` does.
 */
export function envFactsIn(
  filePath: string,
  root: PyNode,
  module: ModuleBinding,
): EnvFileFacts {
  const found: EnvFileFacts = { sites: [], objects: [] };
  walkDescendants<PyNode, Scope>(root, module.moduleScope, {
    at: (node, scope) => {
      if (isEnviron(node, scope) && handsOnward(node)) {
        found.objects.push(keyOf(filePath, node));
      }
      const syntax = envReadSyntaxAt(node, scope);
      if (syntax === null || stringLiteralValue(syntax.name) !== null) {
        return;
      }
      found.sites.push({
        site: nodeId(filePath, node),
        nameKey: keyOf(filePath, syntax.name),
        defaulted: syntax.defaulted,
        functionKey: functionReadKey(filePath, node, scope),
      });
    },
    into: (node, scope) => module.scopeFor.get(node.id) ?? scope,
  });
  return found;
}

/** The key the value facts give an expression, so the rules join on one key. */
const keyOf = (filePath: string, node: PyNode): string =>
  readKey(filePath, node, enclosingFunction(node));

/**
 * The `os.getenv` reference a read goes through, when the source writes
 * the read as a bare function call. `os.environ.get(name)` reads a
 * container the value facts already state.
 */
function functionReadKey(
  filePath: string,
  node: PyNode,
  scope: Scope,
): string | null {
  if (node.type !== "call") {
    return null;
  }
  const callee = field(node, "function");
  if (callee === null || isEnviron(field(callee, "object") ?? callee, scope)) {
    return null;
  }
  return keyOf(filePath, callee);
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
    return (
      field(parent, "attribute")?.text === "get" &&
      call !== null &&
      call.type === "call" &&
      !writesTheKey(firstArgumentOf(call))
    );
  }
  return true;
}

/** Whether the source spells the variable at this read rather than working it out. */
const writesTheKey = (key: PyNode | null): boolean =>
  key !== null && stringLiteralValue(key) !== null;

function firstArgumentOf(call: PyNode): PyNode | null {
  const first = callArguments(call).find(
    (argument) => argument.kind === "positional" && argument.position === 0,
  );
  return first?.node ?? null;
}

/** What one run knows about the environment before the rules are asked. */
interface EnvSiteIndex {
  /** Each site by its node id, so a reader at a call can say whether it has a fallback. */
  byId: Map<string, EnvNameSite>;
  /** Every expression the run says spells the environment, which is what the question is seeded with. */
  objects: Set<string>;
  /** Which sites each parameter ends up naming. Null until the rules have been asked. */
  sitesByParameter: Map<string, string[]> | null;
}

const sitesByDb = new WeakMap<Database, EnvSiteIndex>();

/**
 * State what the files said about the environment and keep the part the
 * rules do not carry, so a reader standing at a call can ask whether one
 * of the callee's parameters is a variable's name.
 */
export function bindEnvNameSites(
  db: Database,
  found: readonly EnvFileFacts[],
): void {
  const sites = found.flatMap((one) => one.sites);
  const objects = found.flatMap((one) => one.objects);
  if (sites.length === 0 && objects.length === 0) {
    return;
  }
  let index = sitesByDb.get(db);
  if (index === undefined) {
    index = { byId: new Map(), objects: new Set(), sitesByParameter: null };
    sitesByDb.set(db, index);
  }
  for (const object of objects) {
    db.add("environmentObject", [object]);
    index.objects.add(object);
  }
  for (const site of sites) {
    index.byId.set(site.site, site);
    if (site.functionKey === null) {
      continue;
    }
    db.add("environmentObject", [site.functionKey]);
    db.add("readsKeyed", [site.site, site.functionKey, site.nameKey]);
    index.objects.add(site.functionKey);
  }
}

/**
 * Which sites each parameter ends up naming, from one question over
 * every expression the run says spells the environment. Asked the first
 * time a reader reaches a call, by when every file's facts are in the
 * database. The reads cannot be the seed: one written through a
 * parameter is off an object no scan of the source would pick out.
 */
function sitesEachParameterNames(
  db: Database,
  index: EnvSiteIndex,
): ReadonlyMap<string, string[]> {
  if (index.sitesByParameter !== null) {
    return index.sitesByParameter;
  }
  resolveEnvSites(db, [...index.objects]);
  const found = new Map<string, string[]>();
  for (const row of db.facts("wantedParamNamesEnv")) {
    const parameter = String(row[0]);
    const named = found.get(parameter) ?? [];
    named.push(String(row[1]));
    found.set(parameter, named);
  }
  index.sitesByParameter = found;
  return found;
}

/**
 * The reads each of these calls makes through the helper it calls, by
 * the call's node. A run that stated no site gives back an empty map
 * before it looks at a single call.
 */
function helperReadsByCall(
  calls: readonly PyNode[],
  db: Database | undefined,
): Map<number, Effect[]> {
  const found = new Map<number, Effect[]>();
  const index = db === undefined ? undefined : sitesByDb.get(db);
  if (db === undefined || index === undefined || calls.length === 0) {
    return found;
  }
  const named = sitesEachParameterNames(db, index);
  if (named.size === 0) {
    return found;
  }

  const calleeKeys = new Map<number, string>();
  for (const call of calls) {
    const callee = field(call, "function");
    const key = callee === null ? null : resolutionKeyOf(callee, db);
    if (key !== null) {
      calleeKeys.set(call.id, key);
    }
  }
  if (calleeKeys.size === 0) {
    return found;
  }
  resolveCalls(db, [...new Set(calleeKeys.values())]);

  for (const call of calls) {
    const key = calleeKeys.get(call.id);
    if (key === undefined) {
      continue;
    }
    const argumentAt = argumentsByParameter(db, call, key);
    if (argumentAt.size === 0) {
      continue;
    }
    const reads = readsThroughHelper(db, call, argumentAt, index.byId, named);
    if (reads.length > 0) {
      found.set(call.id, reads);
    }
  }
  return found;
}

/**
 * The argument this call writes at each of the callee's parameters, by
 * the parameter's key. A parameter the call writes nothing at is left
 * out, and so is a callee nothing in the run resolves.
 */
function argumentsByParameter(
  db: Database,
  call: PyNode,
  calleeKey: string,
): Map<string, PyNode> {
  const written = callArguments(call);
  if (written.length === 0) {
    return new Map();
  }
  const positional = new Map<string, PyNode>();
  const byName = new Map<string, PyNode>();
  for (const argument of written) {
    if (argument.kind === "keyword") {
      byName.set(argument.name, argument.node);
      continue;
    }
    positional.set(String(argument.position), argument.node);
  }

  const argumentAt = new Map<string, PyNode>();
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
  return argumentAt;
}

/**
 * What a call reads, given the argument it writes at each of the
 * callee's parameters. The name is the argument's own value. A variable
 * has a fallback when every read the call reaches supplies one, or when
 * the caller wrote an `or` of its own around the call.
 */
function readsThroughHelper(
  db: Database,
  call: PyNode,
  argumentAt: ReadonlyMap<string, PyNode>,
  siteById: ReadonlyMap<string, EnvNameSite>,
  named: ReadonlyMap<string, string[]>,
): Effect[] {
  const reads = new Map<string, boolean>();
  for (const [parameter, argument] of argumentAt) {
    const sites = named.get(parameter);
    if (sites === undefined) {
      continue;
    }
    const name = stringLiteralValue(argument) ?? stringValueOf(argument, db);
    if (name === null) {
      continue;
    }
    for (const id of sites) {
      // A site the rules derived is a read in a helper's own body, and
      // nothing scanned it for a fallback, so it supplies none.
      const defaulted = siteById.get(id)?.defaulted ?? false;
      reads.set(name, (reads.get(name) ?? true) && defaulted);
    }
  }
  if (reads.size === 0) {
    return [];
  }
  const defaultedAtCall = isDefaultedAt(call);
  return [...reads].map(([name, defaulted]) =>
    configReadEffect({ name, defaulted: defaulted || defaultedAtCall }),
  );
}
