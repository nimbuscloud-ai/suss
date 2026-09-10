/**
 * What a call's callee is: a project method the walk can step into, or
 * a reason it cannot.
 *
 * The rules in @suss/resolution say what the receiver is. Every hop that
 * moves a value, a local reassigned, a name aliased through two more,
 * `Klass.new`, a method that returns `self`, parentheses, is a step they
 * already state, so nothing here reads a receiver for itself.
 *
 * Which method of that class then runs is Ruby's own question, and
 * `ancestry.ts` settles it: `include` puts modules in the lookup order
 * at load time, a subclass overrides what its base declares, and `def
 * self.` is looked up somewhere else again.
 */

import {
  calleeOutcomeOf,
  calleeOutcomes,
  couldBeSettled,
} from "@suss/resolution";

import { methodInAncestry } from "../ancestry.js";
import { field, singletonMethodsByName } from "../ast.js";
import { RUBY_PROGRAM } from "../facts/resolve.js";
import { readKey } from "../facts/values.js";
import { calleeMethodName } from "../paths/effects.js";

import type { UnfollowedReason } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { CalleeOutcome } from "@suss/resolution";
import type { AncestorLookup, Ancestry, ReachedBody } from "../ancestry.js";
import type { RbNode } from "../parser.js";

/** A method in this run, and the export path its summary gets. */
export interface ReachedFunction {
  readonly file: string;
  /** The `method` node. */
  readonly node: RbNode;
  readonly name: string;
  /** `[name]` for a method defined outside any class, `[qualifiedName, name]` for one written in a class body. */
  readonly exportPath: string[];
  /** The class the method is written in, so a further call from inside it resolves against the right ancestry. Null for a method defined outside any class. */
  readonly enclosingQualifiedName: string | null;
}

export type CalleeResolution =
  | { readonly kind: "followed"; readonly target: ReachedFunction }
  | { readonly kind: "stopped"; readonly reason: UnfollowedReason };

export interface ReachContext {
  readonly lookup: AncestorLookup;
  /** Every class the run defines, with its method-lookup order worked out once, so placing a call reads a map rather than walking the chain again. */
  readonly ancestries: ReadonlyMap<string, Ancestry>;
  /** Every method a project file writes outside any class or module, by name. More than one file writing the same name settles nothing. */
  readonly topLevelMethods: ReadonlyMap<string, ReachedFunction[]>;
  /** The value facts, which are where a receiver is settled. */
  readonly facts: Database;
  /** The name of each class the run defines, by the key the value facts give its node. */
  readonly classNames: ReadonlyMap<string, string>;
  /** The method each function key was read from. */
  readonly definitions: ReadonlyMap<string, ReachedFunction>;
}

/** Where a call is written: the file, the method whose body it is, and the class that method belongs to. */
export interface CallSite {
  readonly file: string;
  /** The method being scanned, which is what keys its own locals. */
  readonly method: RbNode;
  /** That method's key, which is what tells its own parameters apart. */
  readonly owner: string;
  readonly enclosingQualifiedName: string | null;
}

const DYNAMIC_SEND_NAMES = new Set(["send", "public_send", "__send__"]);

/** The one method name that runs the receiver itself rather than something the receiver holds. */
const INVOKES_RECEIVER = "call";

/** The word this adapter puts on each outcome the rules settle nothing for. */
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

function followed(target: ReachedFunction): CalleeResolution {
  return { kind: "followed", target };
}

/** A call whose receiver goes to the rules, and what is read off it. */
interface ReceiverSpelling {
  readonly kind: "receiver";
  /** The key the receiver expression is asked about. */
  readonly key: string;
  readonly method: string;
  /** Whether the receiver names the class itself, `Klass.build`, rather than one of it. */
  readonly onClassItself: boolean;
}

/** Where a callee is settled: the receiver's key, the name Ruby looks up on `self`, or the stop neither would reach. */
type CalleeSpelling =
  | ReceiverSpelling
  | { readonly kind: "implicitSelf"; readonly name: string }
  | { readonly kind: "stopped"; readonly reason: UnfollowedReason };

/** What a batch of calls came down to: the key each receiver was asked under, and what came back. */
export interface CalleeSpellings {
  readonly spellingOf: ReadonlyMap<number, CalleeSpelling>;
  readonly outcomes: ReadonlyMap<string, CalleeOutcome>;
}

/** What every one of these calls is made through, asked as one batch. */
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

/** What a call's callee comes down to, once `calleeSpellings` has asked about the batch. */
export function resolveCallee(
  call: RbNode,
  site: CallSite,
  ctx: ReachContext,
  read?: CalleeSpellings,
): CalleeResolution {
  const spelling = read?.spellingOf.get(call.id) ?? spellingFor(call, site);
  if (spelling.kind === "stopped") {
    return spelling;
  }
  if (spelling.kind === "implicitSelf") {
    return resolveImplicitSelf(spelling.name, site, ctx);
  }
  return asCallee(spelling, outcomeFor(spelling.key, ctx, read), site, ctx);
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
 * Whether to ask the rules about this no-argument call at all. Ask when
 * the run says anything about its receiver. Most of what a Rails body
 * writes is `config.host` on a name nothing built, and asking about
 * every one of those makes each later question costlier without
 * changing an answer.
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
 * Whether a call written with no arguments is a method call rather than
 * a property read. It is one when the rules bring its receiver down to
 * something this run defines. `config.host`, whose receiver they say
 * nothing about, is the property read, and reporting it as a call would
 * put an effect and a gap on every attribute a body reads.
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

/** Where the receiver of this call is settled, or the name Ruby would look up on `self`. */
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
    // A method or a lambda a name refers to is run by calling it, and any
    // other name read off one belongs to the language.
    return spelling.method === INVOKES_RECEIVER
      ? functionCallee(outcome.key, ctx)
      : NO_DECLARATION;
  }
  return stop(STOP_FOR[outcome.kind] ?? "noDeclaration");
}

/**
 * The objects a receiver could be. `objectOf` covers a call that gave one
 * back as well as a name that refers to one, which is what a builder
 * returning `self` needs and what `comesTo` refuses to say about a call.
 */
function objectsBehind(facts: Database, key: string): string[] {
  return [
    ...new Set(
      facts.lookup("wantedObjectOf", 0, key).map((row) => String(row[1])),
    ),
  ];
}

/**
 * Which method of a class runs. A class named in the source is the class
 * object itself, so `Klass.build` looks for `def self.build` and
 * `Klass.new` runs the class's own `initialize`. Anything else the rules
 * settled on a class is one of that class, and its methods come from the
 * ancestry.
 */
function methodOnObject(
  spelling: ReceiverSpelling,
  objectKey: string,
  ctx: ReachContext,
): CalleeResolution {
  const qualifiedName = ctx.classNames.get(objectKey);
  // An array, a hash, or anything else written out where it is used.
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
 * A parameter of the method being scanned, called by name, runs whatever
 * its caller passed. A method read off that parameter runs something
 * only the caller's value would name, and another method's parameter is
 * a value this body cannot see at all.
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
 * What `method(:name)` refers to, resolved the same way a bare call to
 * `name` would be: a project method this run can follow, or null for
 * anything else. Used for a `method(:name)` reference passed by name
 * into a call, as an argument or as an `&`-prefixed block argument.
 */
export function resolveMethodReference(
  name: string,
  site: CallSite,
  ctx: ReachContext,
): ReachedFunction | null {
  const resolved = resolveImplicitSelf(name, site, ctx);
  return resolved.kind === "followed" ? resolved.target : null;
}

/** Whether the enclosing class's ancestry saying nothing here still leaves Object's own private methods worth a look, rather than a case this run already settled. */
function leavesRoomForATopLevelMethod(reason: UnfollowedReason): boolean {
  return reason === "noDeclaration" || reason === "outsideRun";
}

/** A bare or explicit-`self` call: the enclosing class's own ancestry first, then every method the project writes outside a class, the way Ruby mixes `Object`'s private methods into everything. */
function resolveImplicitSelf(
  methodName: string,
  site: CallSite,
  ctx: ReachContext,
): CalleeResolution {
  if (site.enclosingQualifiedName !== null) {
    const onClass = methodOnAncestryOf(
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
  return resolveTopLevelName(methodName, ctx);
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
  const found = methodInAncestry(ancestry, methodName);
  if (found.type === "found") {
    return followed(reachedMethod(found.method, found.block, methodName));
  }
  if (found.type === "unsettled") {
    // An ancestor this run never indexed is a class the project does
    // not define, the same as calling straight into a dependency.
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
 * `Const.method`: a class method called straight on the constant, which
 * runs `def self.method` written in the class's own body. This does
 * not walk the ancestry the way an instance method does, since `def
 * self.` on a superclass is inherited through a different mechanism
 * than `include`/`prepend` mix instance methods in.
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
    const found = singletonMethodsByName(block.info.bodyNode).get(methodName);
    if (found !== undefined) {
      return followed(reachedMethod(found, block, methodName));
    }
  }
  return NO_DECLARATION;
}
