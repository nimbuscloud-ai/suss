/**
 * What a call's callee is: a project method the walk can step into, or
 * a reason it cannot. Ruby has no binder for local variables, so this
 * follows only what the source spells out directly: a bare or `self`
 * call resolved through the enclosing class's own ancestry, a call on
 * a known project class (`Const.new.method`, or `Const.method` for a
 * method defined with `def self.`), and a bare call to a method
 * defined outside any class, which Ruby treats as private on every
 * object. Everything else, a local variable, a parameter, `send`, a
 * chain built from something other than `.new`, stops rather than
 * guesses.
 */

import { ancestryOf, methodInAncestry } from "../ancestry.js";
import { bodyStatements, field, singletonMethodsByName } from "../ast.js";
import { qualifyConstantRef, shadowingClassFor } from "../scope.js";

import type { UnfollowedReason } from "@suss/behavioral-ir";
import type { AncestorLookup, ReachedBody } from "../ancestry.js";
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
  readonly knownClasses: ReadonlySet<string>;
  /** Every method a project file writes outside any class or module, by name. More than one file writing the same name settles nothing. */
  readonly topLevelMethods: ReadonlyMap<string, ReachedFunction[]>;
}

/** Where a call is written: the class its enclosing method belongs to, if any, and the nesting that class's body runs a bare constant against. */
export interface CallSite {
  readonly enclosingQualifiedName: string | null;
  readonly nesting: readonly string[];
}

const DYNAMIC_SEND_NAMES = new Set(["send", "public_send", "__send__"]);

const stop = (reason: UnfollowedReason): CalleeResolution => ({
  kind: "stopped",
  reason,
});

function followed(target: ReachedFunction): CalleeResolution {
  return { kind: "followed", target };
}

function methodNameOf(call: RbNode): string | undefined {
  return (field(call, "method") ?? bodyStatements(call)[0])?.text;
}

export async function resolveCallee(
  call: RbNode,
  site: CallSite,
  ctx: ReachContext,
): Promise<CalleeResolution> {
  const methodName = methodNameOf(call);
  if (methodName === undefined) {
    return stop("noDeclaration");
  }
  if (DYNAMIC_SEND_NAMES.has(methodName)) {
    return stop("unsettledValue");
  }

  const receiver = field(call, "receiver");
  if (receiver === null || receiver.type === "self") {
    return resolveImplicitSelf(methodName, site, ctx);
  }
  return resolveOnReceiver(receiver, methodName, site, ctx);
}

/** Whether the enclosing class's ancestry saying nothing here still leaves Object's own private methods worth a look, rather than a case this run already settled. */
function leavesRoomForATopLevelMethod(reason: UnfollowedReason): boolean {
  return reason === "noDeclaration" || reason === "outsideRun";
}

/** A bare or explicit-`self` call: the enclosing class's own ancestry first, then every method the project writes outside a class, the way Ruby mixes `Object`'s private methods into everything. */
async function resolveImplicitSelf(
  methodName: string,
  site: CallSite,
  ctx: ReachContext,
): Promise<CalleeResolution> {
  if (site.enclosingQualifiedName !== null) {
    const onClass = await methodOnAncestryOf(
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
    return stop("noDeclaration");
  }
  if (candidates.length > 1) {
    return stop("multipleSources");
  }
  return followed(candidates[0] as ReachedFunction);
}

async function resolveOnReceiver(
  receiver: RbNode,
  methodName: string,
  site: CallSite,
  ctx: ReachContext,
): Promise<CalleeResolution> {
  // `Service.new.run`: the receiver is itself a call that builds an
  // instance, and the method runs on that instance.
  if (receiver.type === "call") {
    const innerName = methodNameOf(receiver);
    const innerReceiver = field(receiver, "receiver");
    if (innerName === "new" && innerReceiver !== null) {
      const classRef = classRefOf(innerReceiver, site, ctx);
      return classRef === null
        ? stop("unsettledValue")
        : methodOnAncestryOf(classRef, methodName, ctx);
    }
    // `Rails.cache.delete`: rooted at a constant this run does not own.
    const root = rootConstantOf(receiver);
    if (root === null) {
      return stop("unsettledValue");
    }
    return classRefOf(root, site, ctx) === null
      ? stop("outsideRun")
      : stop("unsettledValue");
  }

  if (receiver.type === "constant" || receiver.type === "scope_resolution") {
    const classRef = classRefOf(receiver, site, ctx);
    return classRef === null
      ? stop("outsideRun")
      : singletonMethodOn(classRef, methodName, ctx);
  }

  // A local variable, a parameter, an instance variable, or anything
  // else this run has no binder for.
  return stop("unsettledValue");
}

/** The constant a chain of receivers starts at, `Rails` in `Rails.cache.delete`. Null when the chain bottoms out on anything else. */
function rootConstantOf(node: RbNode): RbNode | null {
  if (node.type === "constant" || node.type === "scope_resolution") {
    return node;
  }
  if (node.type !== "call") {
    return null;
  }
  const receiver = field(node, "receiver");
  return receiver === null ? null : rootConstantOf(receiver);
}

function classRefOf(
  node: RbNode,
  site: CallSite,
  ctx: ReachContext,
): string | null {
  if (node.type === "constant") {
    const shadow = shadowingClassFor(node, site.nesting, ctx.knownClasses);
    if (shadow !== null) {
      return shadow;
    }
    const qualified = qualifyConstantRef(node, site.nesting);
    return qualified !== null && ctx.knownClasses.has(qualified)
      ? qualified
      : null;
  }
  if (node.type === "scope_resolution") {
    const qualified = qualifyConstantRef(node, site.nesting);
    return qualified !== null && ctx.knownClasses.has(qualified)
      ? qualified
      : null;
  }
  return null;
}

async function methodOnAncestryOf(
  qualifiedName: string,
  methodName: string,
  ctx: ReachContext,
): Promise<CalleeResolution> {
  const ownBlocks = ctx.lookup.localDefinition?.(qualifiedName) ?? null;
  if (ownBlocks === null) {
    return stop("outsideRun");
  }
  const ancestry = await ancestryOf(qualifiedName, ownBlocks, ctx.lookup);
  const found = methodInAncestry(ancestry, methodName);
  if (found.type === "found") {
    return followed(reachedMethod(found.method, found.block, methodName));
  }
  if (found.type === "unsettled") {
    // An ancestor this run never indexed is a class the project does
    // not define, the same as calling straight into a dependency.
    return stop(
      found.cause === "dynamicDefine" ? "unsettledValue" : "outsideRun",
    );
  }
  return stop("noDeclaration");
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
  return stop("noDeclaration");
}
