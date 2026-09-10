/**
 * What a call's callee is: a function in this run the walk can step
 * into, or a reason it cannot.
 *
 * The rules in @suss/resolution decide it. Every language feature that
 * moves a value is a hop they already state, so nothing here reads a
 * name, an alias, an attribute, or an instance for itself.
 *
 * What is left is about files rather than values: a module before the
 * dot, and a name only a wildcard import could have brought in.
 */

import {
  calleeOutcomeOf,
  calleeOutcomes,
  writtenSourcesOf,
} from "@suss/resolution";

import { children, enclosingFunction, field, isFunction } from "../ast.js";
import { readKey } from "../facts/values.js";
import { resolveModule } from "../moduleResolver.js";
import { resolveName } from "../scope.js";

import type { UnfollowedReason } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { CalleeOutcome } from "@suss/resolution";
import type { PyNode } from "../parser.js";
import type { BoundPythonFile } from "../routers.js";
import type { Scope } from "../scope.js";

/** A function in this run, and the export path its summary gets. */
export interface ReachedFunction {
  readonly file: BoundPythonFile;
  /** The `function_definition` node. */
  readonly node: PyNode;
  readonly name: string;
  /** `[name]` for a module function, `[Class, name]` for a method. */
  readonly exportPath: string[];
}

export type CalleeResolution =
  | { readonly kind: "followed"; readonly target: ReachedFunction }
  | { readonly kind: "stopped"; readonly reason: UnfollowedReason };

export interface ResolveContext {
  /** Every file this run read, by absolute path. */
  readonly filesByPath: ReadonlyMap<string, BoundPythonFile>;
  readonly roots: string[];
  /** The value facts, which are where a callee is settled. */
  readonly facts: Database;
  /** The function each function key was read from. */
  readonly definitions: ReadonlyMap<string, PyNode>;
}

/** Where a call is written: the file, the binder's scope there, and the function whose body it is. */
export interface CallSite {
  readonly file: BoundPythonFile;
  readonly scope: Scope;
  /** The key of the function being scanned, which is what tells its own parameters apart. */
  readonly owner: string;
}

/** The word this adapter puts on each outcome the rules refuse with. */
const STOP_FOR: Record<string, UnfollowedReason> = {
  severalSources: "multipleSources",
  outsideRun: "outsideRun",
  unsettled: "unsettledValue",
  undeclared: "noDeclaration",
};

const NO_DECLARATION: CalleeResolution = {
  kind: "stopped",
  reason: "noDeclaration",
};

/** The key the rules settle a callee under, or the stop that key would never reach. */
type CalleeSpelling =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "stopped"; readonly reason: UnfollowedReason };

/** What a batch of calls came down to: the key each was asked under, and what came back. */
export interface CalleeSpellings {
  readonly spellingOf: ReadonlyMap<number, CalleeSpelling>;
  readonly outcomes: ReadonlyMap<string, CalleeOutcome>;
}

/**
 * What every one of these calls is made through, asked as one batch. A
 * callee written through modules is asked about under the name the
 * module declares.
 */
export function calleeSpellings(
  calls: readonly { call: PyNode; site: CallSite }[],
  ctx: ResolveContext,
): CalleeSpellings {
  const spellingOf = new Map<number, CalleeSpelling>();
  const keys = new Set<string>();
  for (const { call, site } of calls) {
    const spelling = spellingFor(call, site, ctx);
    spellingOf.set(call.id, spelling);
    if (spelling.kind === "key") {
      keys.add(spelling.key);
    }
  }
  return { spellingOf, outcomes: calleeOutcomes(ctx.facts, [...keys]) };
}

/** What a call's callee comes down to, once `calleeSpellings` has asked about the batch. */
export function resolveCallee(
  call: PyNode,
  site: CallSite,
  ctx: ResolveContext,
  read?: CalleeSpellings,
): CalleeResolution {
  const spelling =
    read?.spellingOf.get(call.id) ?? spellingFor(call, site, ctx);
  if (spelling.kind === "stopped") {
    return spelling;
  }
  const outcome =
    read?.outcomes.get(spelling.key) ??
    calleeOutcomeOf(ctx.facts, spelling.key);
  return asCallee(outcome, site.owner, ctx);
}

/**
 * The function a name refers to, when the name is the function's own. A
 * name a scope assigned a function to is left out, since what counts is
 * a function passed by the name it was declared under.
 */
export function functionNamed(
  nameKey: string,
  ctx: ResolveContext,
): ReachedFunction | null {
  if (assignedElsewhere(ctx.facts, nameKey)) {
    return null;
  }
  const outcome = calleeOutcomeOf(ctx.facts, nameKey);
  return outcome.kind === "function" ? functionAt(outcome.key, ctx) : null;
}

/** Whether a write in this run gave the name a value other than a function declared under it. */
function assignedElsewhere(facts: Database, nameKey: string): boolean {
  return writtenSourcesOf(facts, nameKey).some(
    (source) => !facts.has("func", [source]),
  );
}

/** Parentheses say nothing about a value, so a callee is read through them. */
function readThrough(node: PyNode | null): PyNode | null {
  if (node?.type !== "parenthesized_expression") {
    return node;
  }
  return readThrough(children(node)[0] ?? null);
}

/** The key the rules settle a callee under, which for a module member is the name that module declares. */
function spellingFor(
  call: PyNode,
  site: CallSite,
  ctx: ResolveContext,
): CalleeSpelling {
  const callee = readThrough(field(call, "function"));
  if (callee === null) {
    return { kind: "stopped", reason: "noDeclaration" };
  }
  return (
    throughModules(callee, site, ctx) ?? {
      kind: "key",
      key: readKey(site.file.file, callee, enclosingFunction(callee)),
    }
  );
}

/** Calling a class runs its `__init__`; every other refusal keeps the word this adapter puts on it. */
function asCallee(
  outcome: CalleeOutcome,
  owner: string,
  ctx: ResolveContext,
): CalleeResolution {
  if (outcome.kind === "function") {
    return functionCallee(outcome.key, ctx);
  }
  if (outcome.kind === "object") {
    return constructorOf(outcome.key, ctx);
  }
  if (outcome.kind === "callerSupplied") {
    // Some other function's parameter is a value this body cannot see,
    // rather than something this body's own caller decides.
    return outcome.key.startsWith(`${owner}#`)
      ? { kind: "stopped", reason: "callerSupplied" }
      : { kind: "stopped", reason: "unsettledValue" };
  }
  return {
    kind: "stopped",
    reason: STOP_FOR[outcome.kind] ?? "noDeclaration",
  };
}

/** A lambda has no summary of its own, so a call that comes down to one stops here. */
function functionCallee(key: string, ctx: ResolveContext): CalleeResolution {
  if (ctx.definitions.get(key)?.type === "lambda") {
    return { kind: "stopped", reason: "unsettledValue" };
  }
  const target = functionAt(key, ctx);
  return target === null ? NO_DECLARATION : { kind: "followed", target };
}

function constructorOf(
  classKey: string,
  ctx: ResolveContext,
): CalleeResolution {
  const declared = ctx.facts
    .lookup("holdsProperty", 0, classKey)
    .find((row) => String(row[1]) === "__init__");
  if (declared === undefined) {
    return NO_DECLARATION;
  }
  return functionCallee(String(declared[2]), ctx);
}

/** The function a key was read from, with the class it is a method of when it is one. */
function functionAt(key: string, ctx: ResolveContext): ReachedFunction | null {
  const node = ctx.definitions.get(key);
  const file = ctx.filesByPath.get(key.slice(0, key.lastIndexOf(":")));
  if (node === undefined || file === undefined) {
    return null;
  }
  const name = field(node, "name")?.text ?? "<anon>";
  const owner = ownerClassOf(node);
  const ownerName = owner === null ? undefined : field(owner, "name")?.text;
  return {
    file,
    node,
    name,
    exportPath: ownerName === undefined ? [name] : [ownerName, name],
  };
}

/** The class a function is a method of, or null for a function written anywhere else. */
function ownerClassOf(node: PyNode): PyNode | null {
  for (let up = node.parent; up !== null; up = up.parent) {
    if (isFunction(up)) {
      return null;
    }
    if (up.type === "class_definition") {
      return up;
    }
  }
  return null;
}

/** A module this run read, or a dotted path under a package it did not. */
type ModuleStep =
  | { kind: "module"; file: BoundPythonFile }
  | {
      kind: "package";
      dotted: string;
      relativeLevel: number;
      from: BoundPythonFile;
    };

/**
 * The module-level name a callee ends at, when what it is read off is a
 * module rather than a value, or when nothing but a wildcard import
 * could have brought the name in. Null for every other callee, which
 * leaves the rules to settle it from the key the call site gives.
 */
function throughModules(
  callee: PyNode,
  site: CallSite,
  ctx: ResolveContext,
): CalleeSpelling | null {
  if (callee.type === "identifier") {
    return resolveName(site.scope, callee.text) === null
      ? openImportMember(site.file, callee.text, ctx, new Set())
      : null;
  }
  if (callee.type !== "attribute") {
    return null;
  }
  const object = field(callee, "object");
  const attribute = field(callee, "attribute");
  if (object === null || attribute === null) {
    return null;
  }
  const base = moduleAt(object, site, ctx);
  return base === null ? null : memberKey(base, attribute.text, ctx);
}

/**
 * A `from x import *` brings in whatever `x` declares, so a name nothing
 * else binds is looked for in every module the file opened. One
 * declaration is followed; two leave the call undecided.
 */
function openImportMember(
  file: BoundPythonFile,
  name: string,
  ctx: ResolveContext,
  visited: Set<string>,
): CalleeSpelling | null {
  if (visited.has(file.file)) {
    return null;
  }
  visited.add(file.file);

  const found = new Set<string>();
  for (const spec of file.module.openImports) {
    const dots = spec.length - spec.replace(/^\.+/, "").length;
    const opened = moduleNamed(file, spec.slice(dots), dots, ctx);
    if (opened === null || opened.kind !== "module") {
      continue;
    }
    const member = opened.file.module.moduleScope.bindings.has(name)
      ? { kind: "key" as const, key: `${opened.file.file}#${name}` }
      : openImportMember(opened.file, name, ctx, visited);
    if (member?.kind === "key") {
      found.add(member.key);
    }
  }
  if (found.size > 1) {
    return { kind: "stopped", reason: "multipleSources" };
  }
  const only = [...found][0];
  return only === undefined ? null : { kind: "key", key: only };
}

/** The module a receiver is, following the dotted chain the source writes. */
function moduleAt(
  node: PyNode,
  site: CallSite,
  ctx: ResolveContext,
): ModuleStep | null {
  if (node.type === "identifier") {
    return importedModule(node.text, site, ctx);
  }
  if (node.type !== "attribute") {
    return null;
  }
  const object = field(node, "object");
  const attribute = field(node, "attribute");
  if (object === null || attribute === null) {
    return null;
  }
  const base = moduleAt(object, site, ctx);
  return base === null ? null : submoduleOf(base, attribute.text, ctx);
}

/** What an import binds a name to: `import a.b.c` binds the package `a`, and `as m` binds the module itself. */
function importedModule(
  name: string,
  site: CallSite,
  ctx: ResolveContext,
): ModuleStep | null {
  const binding = resolveName(site.scope, name);
  if (binding?.kind === "import") {
    const head = binding.module.split(".")[0];
    const dotted =
      binding.localName === head ? binding.localName : binding.module;
    return moduleNamed(site.file, dotted, 0, ctx);
  }
  if (binding?.kind !== "importFrom") {
    return null;
  }
  const from = moduleNamed(
    site.file,
    binding.module,
    binding.relativeLevel,
    ctx,
  );
  return from === null ? null : submoduleOf(from, binding.importedName, ctx);
}

/** The module a dotted segment lands on, which under a package is another dotted segment. */
function submoduleOf(
  base: ModuleStep,
  name: string,
  ctx: ResolveContext,
): ModuleStep | null {
  if (base.kind === "package") {
    return moduleNamed(
      base.from,
      base.dotted === "" ? name : `${base.dotted}.${name}`,
      base.relativeLevel,
      ctx,
    );
  }
  // A package's `__init__.py` need say nothing about a submodule beside it.
  return base.file.file.endsWith("__init__.py")
    ? moduleNamed(base.file, name, 1, ctx)
    : null;
}

/** The key a module's own name joins on, or what one of its wildcard imports brought in. */
function memberKey(
  base: ModuleStep,
  name: string,
  ctx: ResolveContext,
): CalleeSpelling | null {
  if (base.kind === "package") {
    return null;
  }
  if (base.file.module.moduleScope.bindings.has(name)) {
    return { kind: "key", key: `${base.file.file}#${name}` };
  }
  return openImportMember(base.file, name, ctx, new Set());
}

function moduleNamed(
  from: BoundPythonFile,
  module: string,
  relativeLevel: number,
  ctx: ResolveContext,
): ModuleStep | null {
  const resolution = resolveModule(
    from.file,
    { module, relativeLevel },
    { roots: ctx.roots },
  );
  // A dotted name with no file of its own may still head a package
  // without an `__init__.py`, so its members are looked for as modules.
  if (resolution.status !== "resolved") {
    return resolution.reason === "external"
      ? { kind: "package", dotted: module, relativeLevel, from }
      : null;
  }
  const file = ctx.filesByPath.get(resolution.file);
  return file === undefined ? null : { kind: "module", file };
}
