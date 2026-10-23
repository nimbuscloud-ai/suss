/**
 * What a call's callee is: a function in this run that the walk can
 * follow, or the reason it cannot.
 *
 * The rules in `@suss/resolution` settle the callee. They already follow
 * a value through names, aliases, attributes and instances, so nothing
 * here reads any of those itself.
 *
 * This module handles the two cases that depend on files: a module
 * written before the dot, and a name that only a wildcard import could
 * have brought in.
 */

import {
  answersFor,
  calleeOutcomeOf,
  calleeOutcomes,
  dispatchOutcomes,
  fileOfKey,
  memberOf,
  nodeOfKey,
  noteKeyRead,
  RECEIVER_STORE_NAME,
  resolutionProgram,
  SELF_AS_CLASS_NAME,
  selfFormOf,
  selfResultOf,
  writtenSourcesOf,
} from "@suss/resolution";

import { children, enclosingFunction, field, isFunction } from "../ast.js";
import { resolveCalls } from "../facts/resolve.js";
import { nodeId, readKey } from "../facts/values.js";
import { resolveModule } from "../moduleResolver.js";
import { resolveName } from "../scope.js";

import type { UnfollowedReason } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { CalleeOutcome, SubclassPlace } from "@suss/resolution";
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
  /** The subclass the method runs on, when the call reached it through a class that inherits it. Calls on `self` or `cls` then resolve against that class. */
  readonly receiverClass?: PythonSubclass;
}

/** A class that inherits a method: its name, the file that declares it, and its key in the value facts. */
export interface PythonSubclass extends SubclassPlace {
  readonly key: string;
}

export type CalleeResolution =
  | { readonly kind: "followed"; readonly target: ReachedFunction }
  | { readonly kind: "stopped"; readonly reason: UnfollowedReason };

export interface ResolveContext {
  /** Every file this run read, by absolute path. */
  readonly filesByPath: ReadonlyMap<string, BoundPythonFile>;
  readonly roots: string[];
  /** The value facts the rules settle a callee from. */
  readonly facts: Database;
  /** The function each function key was read from. */
  readonly definitions: ReadonlyMap<string, PyNode>;
}

/** Where a call is written: the file, the binder's scope there, and the function whose body it is. */
export interface CallSite {
  readonly file: BoundPythonFile;
  readonly scope: Scope;
  /** The key of the function being scanned. A parameter key that starts with it is one of this function's own. */
  readonly owner: string;
  /** The subclass the function being scanned runs on, when it is not the class the function is written in. */
  readonly receiverClass?: PythonSubclass | undefined;
}

/** The gap reason reported for each outcome where the rules stop. */
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

/** The key the rules settle a callee under, or a stop decided before any key is asked about. */
type CalleeSpelling =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "stopped"; readonly reason: UnfollowedReason };

/** A batch of calls resolved together: the key each was asked under, and the outcome for each key. */
export interface CalleeSpellings {
  readonly spellingOf: ReadonlyMap<number, CalleeSpelling>;
  readonly outcomes: ReadonlyMap<string, CalleeOutcome>;
}

/**
 * Resolves the callees of all these calls in one batch. A callee written
 * through modules, `pkg.mod.helper()`, is asked about under the name the
 * module declares.
 */
export function calleeSpellings(
  calls: readonly { call: PyNode; site: CallSite }[],
  ctx: ResolveContext,
): CalleeSpellings {
  const spellingOf = new Map<number, CalleeSpelling>();
  const keys = new Set<string>();
  const receivers = new Set<string>();
  for (const { call, site } of calls) {
    const spelling = spellingFor(call, site, ctx);
    spellingOf.set(call.id, spelling);
    if (spelling.kind === "key") {
      keys.add(spelling.key);
    }
    const receiver = receiverOf(call, site);
    if (receiver !== null) {
      receivers.add(receiver.key);
    }
  }
  const outcomes = calleeOutcomes(ctx.facts, [...keys]);
  resolveCalls(ctx.facts, [...receivers]);
  return { spellingOf, outcomes };
}

/** What a call's callee resolves to, reading the batch from `calleeSpellings` when one is passed. */
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
  const settled: CalleeResolution = selfCallInMixin(call, outcome, site, ctx)
    ? { kind: "stopped", reason: "selfCallInMixin" }
    : asCallee(outcome, site.owner, ctx);
  return onReceiverClass(call, site, ctx, settled) ?? settled;
}

/** A method call's receiver and the name it reads off it. */
interface MethodRead {
  readonly key: string;
  readonly name: string;
}

function receiverOf(call: PyNode, site: CallSite): MethodRead | null {
  const callee = readThrough(field(call, "function"));
  const object = callee?.type === "attribute" ? field(callee, "object") : null;
  const name = callee === null ? undefined : field(callee, "attribute")?.text;
  if (object === null || name === undefined) {
    return null;
  }
  return {
    key: readKey(site.file.file, object, enclosingFunction(object)),
    name,
  };
}

/**
 * The method a call runs when its receiver decides the class: one sent
 * to a class, or an instance of one, that inherits the method it finds;
 * one sent to the scanned method's own `self` or `cls`, or to an
 * instance `cls(...)` made; and one sent to what a method returned when
 * it returns its own receiver. Null when the receiver decides nothing.
 */
function onReceiverClass(
  call: PyNode,
  site: CallSite,
  ctx: ResolveContext,
  settled: CalleeResolution,
): CalleeResolution | null {
  const own = ownReceiverOf(site, ctx);
  const callee = readThrough(field(call, "function"));
  if (callee?.type === "identifier") {
    const calleeKey = readKey(
      site.file.file,
      callee,
      enclosingFunction(callee),
    );
    return own !== null &&
      selfFormOf(ctx.facts, calleeKey, own.key) === SELF_AS_CLASS_NAME
      ? methodOn(own.cls, CONSTRUCTOR_METHOD, ctx)
      : null;
  }
  const read = receiverOf(call, site);
  if (read === null) {
    return null;
  }
  if (own !== null && selfFormOf(ctx.facts, read.key, own.key) !== null) {
    return methodOn(own.cls, read.name, ctx);
  }
  const sentTo = classReturnedTo(read.key, own, ctx);
  if (sentTo !== null) {
    return methodOn(sentTo, read.name, ctx);
  }
  const receiverClass =
    settled.kind === "followed" ? onlyClassOf(read.key, ctx) : null;
  return receiverClass === null || settled.kind !== "followed"
    ? null
    : { kind: "followed", target: runningOn(settled.target, receiverClass) };
}

/** The scanned method's own receiver, and the class it runs on. */
interface OwnReceiver {
  readonly key: string;
  readonly cls: PythonSubclass;
}

function ownReceiverOf(
  site: CallSite,
  ctx: ResolveContext,
): OwnReceiver | null {
  const [row] = ctx.facts.lookup("selfReceiver", 0, site.owner);
  const cls = site.receiverClass ?? classOfFunction(site.owner, ctx);
  return row === undefined || cls === null
    ? null
    : { key: String(row[1]), cls };
}

/**
 * The class a call was sent to, when the method it ran returns its own
 * receiver or one made from it: the class the scanned method runs on, or
 * the one class the receiver settles on.
 */
function classReturnedTo(
  key: string,
  own: OwnReceiver | null,
  ctx: ResolveContext,
): PythonSubclass | null {
  const returned = selfResultOf(ctx.facts, key);
  if (returned === null) {
    return null;
  }
  if (own !== null && returned.receiver === own.key) {
    return own.cls;
  }
  resolveCalls(ctx.facts, [returned.receiver]);
  return onlyClassOf(returned.receiver, ctx);
}

/** The method `__init__` that calling a class runs. */
const CONSTRUCTOR_METHOD = "__init__";

/**
 * The method a class has under a name, its bases' included, as it runs
 * on that class. Null when the class has none, which leaves the call to
 * however the rules settled it.
 */
function methodOn(
  cls: PythonSubclass,
  name: string,
  ctx: ResolveContext,
): CalleeResolution | null {
  const key = memberOf(ctx.facts, cls.key, name, resolutionProgram());
  const found = key === null ? null : functionCallee(key, ctx);
  if (found === null || found.kind !== "followed") {
    return null;
  }
  return { kind: "followed", target: runningOn(found.target, cls) };
}

/** A method as it runs on a class, which differs from the class it is written in when the class inherits it. */
function runningOn(
  target: ReachedFunction,
  cls: PythonSubclass,
): ReachedFunction {
  const owner = ownerClassOf(target.node);
  if (owner === null || nodeId(target.file.file, owner) === cls.key) {
    return target;
  }
  return {
    ...target,
    exportPath: [cls.name, target.name],
    receiverClass: cls,
  };
}

/** The class a method is written in, or null for a function outside any class. */
function classOfFunction(
  functionKey: string,
  ctx: ResolveContext,
): PythonSubclass | null {
  const node = ctx.definitions.get(functionKey);
  const owner = node === undefined ? null : ownerClassOf(node);
  return owner === null ? null : subclassAt(owner, fileOfKey(functionKey));
}

/** The one class a value settles on, as an instance or as the class itself. */
function onlyClassOf(key: string, ctx: ResolveContext): PythonSubclass | null {
  const objects = answersFor(ctx.facts, "wantedObjectOf", key);
  const [only] = objects;
  if (objects.length !== 1 || only === undefined) {
    return null;
  }
  const file = ctx.filesByPath.get(fileOfKey(only));
  const node =
    file === undefined
      ? null
      : nodeOfKey(new Map([[file.file, file.root]]), only);
  return node?.type === "class_definition"
    ? subclassAt(node, file?.file ?? fileOfKey(only))
    : null;
}

function subclassAt(cls: PyNode, file: string): PythonSubclass | null {
  const name = field(cls, "name")?.text;
  return name === undefined ? null : { key: nodeId(file, cls), name, file };
}

/**
 * Whether the call reads a method straight off the receiver of a method
 * in a class with no bases, which does not define it. Only a subclass can
 * supply that method, so the call runs whatever the class that mixes this
 * one in provides. A class with a base is left alone, since the base may
 * come from a library. So is a class that gives its instances the name
 * some other way, by assigning `self.<name>` or through `__getattr__`.
 */
function selfCallInMixin(
  call: PyNode,
  outcome: CalleeOutcome,
  site: CallSite,
  ctx: ResolveContext,
): boolean {
  if (
    outcome.kind !== "callerSupplied" ||
    !outcome.key.startsWith(`${site.owner}#`)
  ) {
    return false;
  }
  const callee = readThrough(field(call, "function"));
  const receiver =
    callee?.type === "attribute" ? field(callee, "object") : null;
  const name = callee === null ? null : field(callee, "attribute")?.text;
  if (receiver?.type !== "identifier" || name === undefined || name === null) {
    return false;
  }
  if (outcome.key !== `${site.owner}#${receiver.text}`) {
    return false;
  }
  return ctx.facts.lookup("instanceOf", 0, outcome.key).some((row) => {
    const classKey = String(row[1]);
    return (
      ctx.facts.has("plainClass", [classKey]) &&
      !instancesHaveAttribute(ctx.facts, classKey, name)
    );
  });
}

/** The method Python calls for an attribute an instance does not have. */
const FALLBACK_ATTRIBUTE = "__getattr__";

/**
 * Whether the class gives its instances the attribute without defining a
 * method by that name: one of its methods assigns `self.<name>`, or it
 * defines `__getattr__`, which can answer for any name.
 */
function instancesHaveAttribute(
  facts: Database,
  classKey: string,
  name: string,
): boolean {
  return facts.lookup("holdsProperty", 0, classKey).some((member) => {
    if (String(member[1]) === FALLBACK_ATTRIBUTE) {
      return true;
    }
    return facts
      .lookup("storesProperty", 0, String(member[2]))
      .some(
        (store) =>
          String(store[1]) === name && store[3] === RECEIVER_STORE_NAME,
      );
  });
}

/**
 * The outcome for each of these keys, asked as one batch. A caller that
 * then reads them one at a time runs the rules once instead of once per
 * key.
 */
export function namedOutcomes(
  keys: readonly string[],
  ctx: ResolveContext,
): ReadonlyMap<string, CalleeOutcome> {
  return calleeOutcomes(ctx.facts, [...new Set(keys)]);
}

/** What a call that takes its function out of a table may run, as the walk follows it. */
export interface DispatchedCall {
  readonly targets: readonly ReachedFunction[];
  /** True when the source narrows the call to one entry that is one function. */
  readonly certain: boolean;
  /** How many entries came to no function this run read. */
  readonly unresolved: number;
}

/**
 * What each of these calls may run, for the ones that take their
 * function out of a table or pick a method by a computed name. One
 * question for the batch.
 */
export function dispatchedCalls(
  calls: readonly { call: PyNode; site: CallSite }[],
  ctx: ResolveContext,
): Map<number, DispatchedCall> {
  const byKey = new Map(
    calls.map(({ call, site }) => [nodeId(site.file.file, call), call]),
  );
  const found = new Map<number, DispatchedCall>();
  for (const [key, outcome] of dispatchOutcomes(ctx.facts, [...byKey.keys()])) {
    const call = byKey.get(key);
    if (call === undefined) {
      continue;
    }
    const targets = new Map<string, ReachedFunction>();
    for (const fn of outcome.functions) {
      for (const target of reachedThrough(fn, outcome.through, ctx)) {
        targets.set(nodeId(target.file.file, target.node), target);
      }
    }
    found.set(call.id, {
      targets: [...targets.values()],
      certain:
        outcome.certain && outcome.functions.every((fn) => !isLambda(fn, ctx)),
      unresolved: outcome.unresolved,
    });
  }
  return found;
}

/**
 * The function a key is. A lambda has no summary of its own, so the walk
 * steps past it to the functions it calls.
 */
function reachedThrough(
  key: string,
  through: ReadonlyMap<string, readonly string[]>,
  ctx: ResolveContext,
): ReachedFunction[] {
  const keys = isLambda(key, ctx) ? (through.get(key) ?? []) : [key];
  return keys.flatMap((one) => {
    const target = isLambda(one, ctx) ? null : functionAt(one, ctx);
    return target === null ? [] : [target];
  });
}

function isLambda(key: string, ctx: ResolveContext): boolean {
  return ctx.definitions.get(key)?.type === "lambda";
}

/**
 * The function a name refers to, when the name is the function's own. A
 * name a scope assigned a function to is left out, since what counts is
 * a function passed by the name it was declared under.
 */
export function functionNamed(
  nameKey: string,
  ctx: ResolveContext,
  read?: ReadonlyMap<string, CalleeOutcome>,
): ReachedFunction | null {
  if (assignedElsewhere(ctx.facts, nameKey)) {
    return null;
  }
  const outcome = read?.get(nameKey) ?? calleeOutcomeOf(ctx.facts, nameKey);
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
  // The grammar writes a callee on every call.
  /* v8 ignore start */
  if (callee === null) {
    return { kind: "stopped", reason: "noDeclaration" };
  }
  /* v8 ignore stop */
  return (
    throughModules(callee, site, ctx) ?? {
      kind: "key",
      key: readKey(site.file.file, callee, enclosingFunction(callee)),
    }
  );
}

/** Calling a class runs its `__init__`. Any other stop is reported with the reason from `STOP_FOR`. */
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
    // Only this function's own parameter is supplied by its caller. A
    // parameter of some other function is a value this body cannot settle.
    return outcome.key.startsWith(`${owner}#`)
      ? { kind: "stopped", reason: "callerSupplied" }
      : { kind: "stopped", reason: "unsettledValue" };
  }
  return {
    kind: "stopped",
    reason: STOP_FOR[outcome.kind] ?? "noDeclaration",
  };
}

/** A lambda has no summary of its own, so a call that resolves to one stops here. */
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
  // The key came from a fact this run emitted for a file it read.
  /* v8 ignore start */
  if (node === undefined || file === undefined) {
    return null;
  }
  /* v8 ignore stop */
  return reachedFunctionOf(file, node);
}

/** A function as the walk records it, with the class it is a method of when it is one. */
export function reachedFunctionOf(
  file: BoundPythonFile,
  node: PyNode,
): ReachedFunction {
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
 * The module-level name a callee ends at, when it is read off a module
 * instead of a value, or when only a wildcard import could have brought
 * the name in. Null for every other callee, and the rules then settle it
 * from the call site's own key.
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
  // The grammar writes both fields on every attribute read.
  /* v8 ignore start */
  if (object === null || attribute === null) {
    return null;
  }
  /* v8 ignore stop */
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
  /* v8 ignore start */
  if (object === null || attribute === null) {
    return null;
  }
  /* v8 ignore stop */
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
  if (file === undefined) {
    return null;
  }
  // The caller goes on to read what that module's own scope binds.
  noteKeyRead(ctx.facts, file.file);
  return { kind: "module", file };
}
