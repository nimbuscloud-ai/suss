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
 * `readsEnvNamed`, the shared rules say which parameters end up as a
 * variable's name, and a reader at a call reads the argument only where
 * a site comes back. The README lists the spellings.
 */

import { runtimeConfigBinding } from "@suss/behavioral-ir";
import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

import { enclosingFunction, field, stringLiteralValue } from "./ast.js";
import { resolveCalls } from "./facts/resolve.js";
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
}

/**
 * Every read in a file whose variable name is not a string literal,
 * function bodies included. A helper's own body is one of those, which
 * is why this walk does not stop where `envReadEffects` does.
 */
export function envNameSites(
  filePath: string,
  root: PyNode,
  module: ModuleBinding,
): EnvNameSite[] {
  const sites: EnvNameSite[] = [];
  walkDescendants<PyNode, Scope>(root, module.moduleScope, {
    at: (node, scope) => {
      const syntax = envReadSyntaxAt(node, scope);
      if (syntax === null || stringLiteralValue(syntax.name) !== null) {
        return;
      }
      sites.push({
        site: nodeId(filePath, node),
        nameKey: readKey(filePath, syntax.name, enclosingFunction(syntax.name)),
        defaulted: syntax.defaulted,
      });
    },
    into: (node, scope) => module.scopeFor.get(node.id) ?? scope,
  });
  return sites;
}

/** The read sites each run knows about, so a reader at a call can say whether the one it landed on has a fallback. */
const sitesByDb = new WeakMap<Database, Map<string, EnvNameSite>>();

/**
 * State the sites for the shared rules and keep them, so a reader
 * standing at a call can ask whether one of the callee's parameters is
 * a variable's name.
 */
export function bindEnvNameSites(
  db: Database,
  sites: readonly EnvNameSite[],
): void {
  if (sites.length === 0) {
    return;
  }
  let known = sitesByDb.get(db);
  if (known === undefined) {
    known = new Map();
    sitesByDb.set(db, known);
  }
  for (const site of sites) {
    db.add("readsEnvNamed", [site.site, site.nameKey]);
    known.set(site.site, site);
  }
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
  const sites = db === undefined ? undefined : sitesByDb.get(db);
  if (db === undefined || sites === undefined || calls.length === 0) {
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

  // Every parameter this body could be naming a variable at goes into
  // one question, because the rules answer all of them in one run.
  const argumentsByCall = new Map<number, Map<string, PyNode>>();
  const asking = new Set<string>();
  for (const call of calls) {
    const key = calleeKeys.get(call.id);
    if (key === undefined) {
      continue;
    }
    const argumentAt = argumentsByParameter(db, call, key);
    if (argumentAt.size === 0) {
      continue;
    }
    argumentsByCall.set(call.id, argumentAt);
    for (const parameter of argumentAt.keys()) {
      asking.add(parameter);
    }
  }
  if (asking.size === 0) {
    return found;
  }
  resolveCalls(db, [...asking]);

  for (const [id, argumentAt] of argumentsByCall) {
    const reads = readsThroughHelper(db, argumentAt, sites);
    if (reads.length > 0) {
      found.set(id, reads);
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
  for (const resolved of db.lookup("wantedResolves", 0, calleeKey)) {
    const callee = String(resolved[1]);
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
 * callee's parameters. The name is the argument's own value and the
 * fallback is the site's, because the helper is what decides what
 * happens when the variable is unset.
 */
function readsThroughHelper(
  db: Database,
  argumentAt: ReadonlyMap<string, PyNode>,
  sites: ReadonlyMap<string, EnvNameSite>,
): Effect[] {
  const reads = new Map<string, EnvRead>();
  for (const [parameter, argument] of argumentAt) {
    const answers = db.lookup("wantedParamNamesEnv", 0, parameter);
    if (answers.length === 0) {
      continue;
    }
    const name = stringLiteralValue(argument) ?? stringValueOf(argument, db);
    if (name === null) {
      continue;
    }
    for (const answer of answers) {
      const site = sites.get(String(answer[1]));
      if (site !== undefined) {
        reads.set(`${site.site} ${name}`, { name, defaulted: site.defaulted });
      }
    }
  }
  return [...reads.values()].map(configReadEffect);
}
