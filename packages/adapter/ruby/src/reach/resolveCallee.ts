/**
 * Resolves a call's callee to a project method the walk can step into, or
 * to the reason it cannot.
 *
 * The rules in @suss/resolution work out what the receiver is. They
 * already follow a reassigned local, a chain of aliases, `Klass.new`, a
 * method that returns `self`, and parentheses, so this file never reads a
 * receiver itself.
 *
 * The ancestry walk then decides which method of that class runs, the way
 * Ruby does: `include` adds modules to the lookup order at load time, a
 * subclass overrides its base, and `def self.` methods are looked up
 * separately.
 */

import {
  calleeOutcomeOf,
  calleeOutcomes,
  couldBeSettled,
} from "@suss/resolution";

import { methodInAncestry } from "../ancestry.js";
import { definesClassMethod, field, singletonMethodsByName } from "../ast.js";
import { classBehind } from "../baseClass.js";
import { RUBY_PROGRAM } from "../facts/resolve.js";
import { readKey } from "../facts/values.js";
import { pickedSource } from "../loaders.js";
import { calleeMethodName } from "../paths/effects.js";

import type { UnfollowedReason } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { CalleeOutcome } from "@suss/resolution";
import type { AncestorLookup, Ancestry, ReachedBody } from "../ancestry.js";
import type { BodyBlocks } from "../ast.js";
import type { DynamicNames } from "../defineMethod.js";
import type { RbLoaderPattern } from "../pack.js";
import type { RbNode } from "../parser.js";

/** A method in this run, and the export path its summary gets. */
export interface ReachedFunction {
  readonly file: string;
  /** The `method` node. */
  readonly node: RbNode;
  readonly name: string;
  /** `[name]` for a method defined outside any class, `[qualifiedName, name]` for one written in a class body. */
  readonly exportPath: string[];
  /** The class the method is written in, so calls from inside it resolve against that class's ancestry. Null for a method defined outside any class. */
  readonly enclosingQualifiedName: string | null;
}

export type CalleeResolution =
  | { readonly kind: "followed"; readonly target: ReachedFunction }
  | {
      readonly kind: "stopped";
      readonly reason: UnfollowedReason;
      /** Set on a call on `self` the resolver could not settle, which the link step may still match by name in the caller's file. */
      readonly matchByName?: true;
    };

export interface ReachContext {
  readonly lookup: AncestorLookup;
  /** The method lookup order of every class the run defines, computed once so resolving a call is a map lookup. */
  readonly ancestries: ReadonlyMap<string, Ancestry>;
  /** Every method a project file defines outside any class or module, by name. A name defined in more than one file does not resolve. */
  readonly topLevelMethods: ReadonlyMap<string, ReachedFunction[]>;
  /** The value facts the rules settle receivers from. */
  readonly facts: Database;
  /** The name of each class the run defines, keyed by the value facts' key for its node. */
  readonly classNames: ReadonlyMap<string, string>;
  /** The method each function key was read from. */
  readonly definitions: ReadonlyMap<string, ReachedFunction>;
  /** The calls whose block the run's packs declare runs as part of the surrounding body. */
  readonly bodyBlocks: BodyBlocks;
  /** The methods each class defines under a name computed at run time, by class key. */
  readonly dynamicNames: DynamicNames;
  /** The run's loader patterns, for reads a batching loader makes for the caller. */
  readonly loaders: readonly RbLoaderPattern[];
}

/** Where a call is written: the file, the method whose body contains it, and that method's class. */
export interface CallSite {
  readonly file: string;
  /** The method being scanned, whose node its locals are keyed on. Null at module scope, where locals are keyed on the file. */
  readonly method: RbNode | null;
  /** That method's key, which its parameters' keys start with. */
  readonly owner: string;
  readonly enclosingQualifiedName: string | null;
}

const DYNAMIC_SEND_NAMES = new Set(["send", "public_send", "__send__"]);

/** The method name that runs the receiver itself, as with a proc or lambda. */
const INVOKES_RECEIVER = "call";

/** The gap reason for each outcome where the rules settle nothing. */
const STOP_FOR: Record<string, UnfollowedReason> = {
  severalSources: "multipleSources",
  outsideRun: "outsideRun",
  unsettled: "unsettledValue",
  undeclared: "noDeclaration",
};

const stop = (reason: UnfollowedReason): CalleeResolution => ({
  kind: "stopped",
  reason,
});

const NO_DECLARATION = stop("noDeclaration");

/**
 * A call on `self` that nothing in the run declares. The method may be
 * one the library adds, or one the name match in the caller's file finds.
 */
const UNSETTLED_ON_SELF: CalleeResolution = {
  kind: "stopped",
  reason: "noDeclaration",
  matchByName: true,
};

function followed(target: ReachedFunction): CalleeResolution {
  return { kind: "followed", target };
}

/** A call whose receiver goes to the rules, and the method called on it. */
interface ReceiverSpelling {
  readonly kind: "receiver";
  /** The key to ask the rules about for the receiver expression. */
  readonly key: string;
  readonly method: string;
  /** Whether the receiver is the class itself, as in `Klass.build`, instead of an instance. */
  readonly onClassItself: boolean;
}

/** How a callee is resolved: through the receiver's key, as a name Ruby looks up on `self`, or not at all. */
type CalleeSpelling =
  | ReceiverSpelling
  | { readonly kind: "implicitSelf"; readonly name: string }
  | { readonly kind: "stopped"; readonly reason: UnfollowedReason };

/** The answers for a batch of calls: each call's spelling, and the outcome for each receiver key. */
export interface CalleeSpellings {
  readonly spellingOf: ReadonlyMap<number, CalleeSpelling>;
  readonly outcomes: ReadonlyMap<string, CalleeOutcome>;
}

/** Asks the rules about the receivers of all these calls in one batch. */
export function calleeSpellings(
  calls: readonly { call: RbNode; site: CallSite }[],
  ctx: ReachContext,
): CalleeSpellings {
  const spellingOf = new Map<number, CalleeSpelling>();
  const keys = new Set<string>();
  for (const { call, site } of calls) {
    const spelling = spellingFor(call, site);
    spellingOf.set(call.id, spelling);
    if (spelling.kind === "receiver") {
      keys.add(spelling.key);
    }
  }
  return {
    spellingOf,
    outcomes: calleeOutcomes(ctx.facts, [...keys], RUBY_PROGRAM),
  };
}

/** Resolves a call's callee. Pass the result of `calleeSpellings` to reuse its batched answers. */
export function resolveCallee(
  call: RbNode,
  site: CallSite,
  ctx: ReachContext,
  read?: CalleeSpellings,
): CalleeResolution {
  const throughLoader = loaderSourceCallee(call, site, ctx);
  if (throughLoader !== null) {
    return throughLoader;
  }

  const spelling = read?.spellingOf.get(call.id) ?? spellingFor(call, site);
  if (spelling.kind === "stopped") {
    return spelling;
  }
  if (spelling.kind === "implicitSelf") {
    return resolveImplicitSelf(spelling.name, site, ctx);
  }
  return asCallee(spelling, outcomeFor(spelling.key, ctx, read), site, ctx);
}

/**
 * A read through a loader runs in the project's own source class, so the
 * call resolves to the method the library runs on that class. Null when
 * no pack declares a source, or when this call does not pick one.
 */
function loaderSourceCallee(
  call: RbNode,
  site: CallSite,
  ctx: ReachContext,
): CalleeResolution | null {
  for (const loader of ctx.loaders) {
    const constant = pickedSource(call, loader);
    const source = loader.source;
    if (constant === null || source === undefined) {
      continue;
    }
    const classKey = classBehind(ctx.facts, site.file, constant);
    const qualifiedName =
      classKey === undefined ? undefined : ctx.classNames.get(classKey);
    if (qualifiedName !== undefined) {
      return methodOnAncestryOf(qualifiedName, source.method, ctx);
    }
  }
  return null;
}

function outcomeFor(
  key: string,
  ctx: ReachContext,
  read?: CalleeSpellings,
): CalleeOutcome {
  return (
    read?.outcomes.get(key) ?? calleeOutcomeOf(ctx.facts, key, RUBY_PROGRAM)
  );
}

/**
 * Whether to ask the rules about this no-argument call at all. Ask only
 * when the facts say something about its receiver. Most such calls in a
 * Rails body are reads like `config.host` on a name nothing in the run
 * built, and asking about each one makes later questions slower without
 * changing any answer.
 */
export function mightReadAsACall(
  call: RbNode,
  site: CallSite,
  ctx: ReachContext,
): boolean {
  const spelling = spellingFor(call, site);
  return (
    spelling.kind === "receiver" && couldBeSettled(ctx.facts, spelling.key)
  );
}

/**
 * Whether a call with no arguments is a method call instead of a property
 * read. It is a call when the rules settle its receiver on a function or
 * object this run defines. `config.host`, whose receiver the rules know
 * nothing about, is a property read. Treating it as a call would add an
 * effect and a gap for every attribute a body reads.
 */
export function readsAsACall(
  call: RbNode,
  site: CallSite,
  ctx: ReachContext,
  read?: CalleeSpellings,
): boolean {
  const spelling = read?.spellingOf.get(call.id) ?? spellingFor(call, site);
  if (spelling.kind !== "receiver") {
    return false;
  }
  const outcome = outcomeFor(spelling.key, ctx, read);
  return outcome.kind === "function" || outcome.kind === "object";
}

/** How this call's callee is resolved: through its receiver's key, or as a name Ruby looks up on `self`. */
function spellingFor(call: RbNode, site: CallSite): CalleeSpelling {
  const methodName = calleeMethodName(call);
  if (methodName === undefined) {
    return { kind: "stopped", reason: "noDeclaration" };
  }
  if (DYNAMIC_SEND_NAMES.has(methodName)) {
    return { kind: "stopped", reason: "unsettledValue" };
  }
  const receiver = field(call, "receiver");
  if (receiver === null || receiver.type === "self") {
    return { kind: "implicitSelf", name: methodName };
  }
  return {
    kind: "receiver",
    key: readKey(site.file, receiver, site.method),
    method: methodName,
    onClassItself:
      receiver.type === "constant" || receiver.type === "scope_resolution",
  };
}

function asCallee(
  spelling: ReceiverSpelling,
  outcome: CalleeOutcome,
  site: CallSite,
  ctx: ReachContext,
): CalleeResolution {
  if (outcome.kind === "severalSources") {
    return stop("multipleSources");
  }
  if (outcome.kind === "callerSupplied") {
    return fromCaller(spelling, outcome.key, site);
  }
  const objects = objectsBehind(ctx.facts, spelling.key);
  if (objects.length > 1) {
    return stop("multipleSources");
  }
  const objectKey =
    objects[0] ?? (outcome.kind === "object" ? outcome.key : undefined);
  if (objectKey !== undefined) {
    return methodOnObject(spelling, objectKey, ctx);
  }
  if (outcome.kind === "function") {
    // A method or lambda runs when `call` is sent to it. Any other method
    // called on it is one Ruby itself defines.
    return spelling.method === INVOKES_RECEIVER
      ? functionCallee(outcome.key, ctx)
      : NO_DECLARATION;
  }
  return stop(STOP_FOR[outcome.kind] ?? "noDeclaration");
}

/**
 * The objects a receiver could be. `objectOf` covers a call that returned
 * an object as well as a name that refers to one. A builder that returns
 * `self` needs the first case, which `comesTo` does not cover.
 */
function objectsBehind(facts: Database, key: string): string[] {
  return [
    ...new Set(
      facts.lookup("wantedObjectOf", 0, key).map((row) => String(row[1])),
    ),
  ];
}

/**
 * Which method of a class runs. A constant receiver is the class object
 * itself, so `Klass.build` looks for `def self.build` and `Klass.new`
 * runs the class's own `initialize`. Any other receiver the rules settle
 * on a class is an instance, and its methods come from the ancestry.
 */
function methodOnObject(
  spelling: ReceiverSpelling,
  objectKey: string,
  ctx: ReachContext,
): CalleeResolution {
  const qualifiedName = ctx.classNames.get(objectKey);
  // An array, a hash, or another literal object.
  if (qualifiedName === undefined) {
    return NO_DECLARATION;
  }
  if (!spelling.onClassItself) {
    return methodOnAncestryOf(qualifiedName, spelling.method, ctx);
  }
  return spelling.method === "new"
    ? methodOnAncestryOf(qualifiedName, "initialize", ctx)
    : singletonMethodOn(qualifiedName, spelling.method, ctx);
}

/**
 * `param.call` on a parameter of the method being scanned runs whatever
 * the caller passed, so it stops as `callerSupplied`. Any other method on
 * that parameter depends on the caller's value, and another method's
 * parameter is not visible from this body, so both stop as unsettled.
 */
function fromCaller(
  spelling: ReceiverSpelling,
  parameterKey: string,
  site: CallSite,
): CalleeResolution {
  if (
    !parameterKey.startsWith(`${site.owner}#`) ||
    spelling.method !== INVOKES_RECEIVER
  ) {
    return stop("unsettledValue");
  }
  return stop("callerSupplied");
}

function functionCallee(key: string, ctx: ReachContext): CalleeResolution {
  const target = ctx.definitions.get(key);
  return target === undefined ? NO_DECLARATION : followed(target);
}

/**
 * What `method(:name)` refers to, resolved the same way as a bare call to
 * `name`: a project method this run can follow, or null. Used when such a
 * reference is passed into a call, as an argument or as an `&` block
 * argument.
 */
export function resolveMethodReference(
  name: string,
  site: CallSite,
  ctx: ReachContext,
): ReachedFunction | null {
  const resolved = resolveImplicitSelf(name, site, ctx);
  return resolved.kind === "followed" ? resolved.target : null;
}

/**
 * Whether a lookup in the enclosing class's ancestry that stopped for
 * this reason should fall back to top-level methods. It does when the
 * ancestry has no declaration or leaves the run, and not when a
 * `define_method` in the ancestry may define the name.
 */
function leavesRoomForATopLevelMethod(reason: UnfollowedReason): boolean {
  return reason === "noDeclaration" || reason === "outsideRun";
}

/**
 * A call with no receiver or with `self`. Looks on the enclosing class
 * first, then among methods the project defines outside any class, which
 * Ruby makes private methods of `Object`.
 */
function resolveImplicitSelf(
  methodName: string,
  site: CallSite,
  ctx: ReachContext,
): CalleeResolution {
  if (site.enclosingQualifiedName !== null) {
    const onClass = methodOnSelf(
      site,
      site.enclosingQualifiedName,
      methodName,
      ctx,
    );
    if (
      onClass.kind === "followed" ||
      !leavesRoomForATopLevelMethod(onClass.reason)
    ) {
      return onClass;
    }
  }
  const topLevel = resolveTopLevelName(methodName, ctx);
  if (topLevel.kind === "followed" || topLevel.reason !== "noDeclaration") {
    return topLevel;
  }
  return declaredForTheOtherSelf(site, methodName, ctx)
    ? NO_DECLARATION
    : UNSETTLED_ON_SELF;
}

/**
 * Whether the enclosing class declares the name for the other kind of
 * `self`: as an instance method when the call is in a class method, or as
 * a class method when it is in an instance method. Ruby never runs that
 * one from here, so a match by name would link the wrong method.
 */
function declaredForTheOtherSelf(
  site: CallSite,
  methodName: string,
  ctx: ReachContext,
): boolean {
  const qualifiedName = site.enclosingQualifiedName;
  if (qualifiedName === null) {
    return false;
  }
  const other = inClassMethod(site, ctx)
    ? methodOnAncestryOf(qualifiedName, methodName, ctx)
    : singletonMethodOn(qualifiedName, methodName, ctx);
  return other.kind === "followed";
}

function inClassMethod(site: CallSite, ctx: ReachContext): boolean {
  return (
    site.method !== null && definesClassMethod(site.method, ctx.bodyBlocks)
  );
}

/**
 * The method a call on `self` runs in the enclosing class. Inside a class
 * method `self` is the class, so the call runs another class method.
 * Anywhere else `self` is an instance, and the ancestry decides.
 */
function methodOnSelf(
  site: CallSite,
  qualifiedName: string,
  methodName: string,
  ctx: ReachContext,
): CalleeResolution {
  if (inClassMethod(site, ctx)) {
    return singletonMethodOn(qualifiedName, methodName, ctx);
  }
  return methodOnAncestryOf(qualifiedName, methodName, ctx);
}

function resolveTopLevelName(
  methodName: string,
  ctx: ReachContext,
): CalleeResolution {
  const candidates = ctx.topLevelMethods.get(methodName);
  if (candidates === undefined || candidates.length === 0) {
    return NO_DECLARATION;
  }
  if (candidates.length > 1) {
    return stop("multipleSources");
  }
  return followed(candidates[0] as ReachedFunction);
}

function methodOnAncestryOf(
  qualifiedName: string,
  methodName: string,
  ctx: ReachContext,
): CalleeResolution {
  const ancestry = ctx.ancestries.get(qualifiedName);
  if (ancestry === undefined) {
    return stop("outsideRun");
  }
  const found = methodInAncestry(ancestry, methodName, {
    facts: ctx.facts,
    bodyBlocks: ctx.bodyBlocks,
    dynamicNames: ctx.dynamicNames,
  });
  if (found.type === "found") {
    return followed(reachedMethod(found.method, found.block, methodName));
  }
  if (found.type === "unsettled") {
    // An ancestor this run never indexed is a class the project does not
    // define, so the call is treated like a call into a dependency.
    return stop(
      found.cause === "dynamicDefine" ? "definedAtLoadTime" : "outsideRun",
    );
  }
  return NO_DECLARATION;
}

function reachedMethod(
  node: RbNode,
  block: ReachedBody,
  name: string,
): ReachedFunction {
  return {
    file: block.file,
    node,
    name,
    exportPath: [block.info.qualifiedName, name],
    enclosingQualifiedName: block.info.qualifiedName,
  };
}

/**
 * A class method called on the class, as `Const.method` or as a bare call
 * inside another class method, which runs a class method written in the
 * class's own body. This does not walk the ancestry, because a
 * superclass's class methods are inherited through a different mechanism
 * from the one `include` and `prepend` use.
 */
function singletonMethodOn(
  qualifiedName: string,
  methodName: string,
  ctx: ReachContext,
): CalleeResolution {
  const ownBlocks = ctx.lookup.localDefinition?.(qualifiedName) ?? null;
  if (ownBlocks === null) {
    return stop("outsideRun");
  }
  for (const block of ownBlocks) {
    if (block.info.bodyNode === null) {
      continue;
    }
    const found = singletonMethodsByName(
      block.info.bodyNode,
      ctx.bodyBlocks,
    ).get(methodName);
    if (found !== undefined) {
      return followed(reachedMethod(found, block, methodName));
    }
  }
  return NO_DECLARATION;
}
