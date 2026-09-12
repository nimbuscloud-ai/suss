// effects.ts: the calls a resolver's own body makes, as invocation effects.
// A call written under an `if` records that test as a precondition, which is
// what the IR means by a call that does not always fire.

import { enumerateOrDegrade, sharedGatingConditions } from "@suss/extractor";
import { constantOf, literalOf } from "@suss/values";

import { field, NodeMap, OWN_BODY_TYPES } from "../ast.js";
import { evaluatedValue } from "../values/evaluator.js";
import { isBareMethodCall, localNamesIn } from "./bareCalls.js";
import { lowerRubyBody } from "./lowering.js";

import type { Database } from "@suss/datalog";
import type { EffectArg, RawEffect } from "@suss/extractor";
import type { RbNode } from "../parser.js";

type InvocationEffect = Extract<RawEffect, { type: "invocation" }>;

/** `raise` is a call in Ruby, but it leaves the method rather than doing work. */
const RAISE_NAMES = new Set(["raise", "fail"]);

/** A statement list, which is where the lowering keys a path. */
const BLOCK_TYPES = new Set([
  "body_statement",
  "then",
  "else",
  "do_block",
  "block",
]);

/** The literal an argument comes down to, or null when it does not come down to one. */
function literalArgOf(
  node: RbNode,
  facts: Database | undefined,
): EffectArg | null {
  const value = evaluatedValue(node, facts);
  const text = literalOf(value);
  if (text !== null) {
    return { kind: "string", value: text };
  }
  const constant = constantOf(value);
  if (typeof constant === "number") {
    return { kind: "number", value: constant };
  }
  if (typeof constant === "boolean") {
    return { kind: "boolean", value: constant };
  }
  return null;
}

function children(node: RbNode): RbNode[] {
  return node.namedChildren.filter((child): child is RbNode => child !== null);
}

/**
 * One invocation per chain. `Order.where(id: 1).limit(10).update(...)` is one
 * thing the code does, and the outermost call's text spells out the whole
 * chain, so emitting the inner links too counts the same work three times.
 */
export function withoutChainLinks(calls: readonly RbNode[]): RbNode[] {
  const isLink = new Set<number>();
  for (const call of calls) {
    const receiver = field(call, "receiver");
    if (receiver !== null && receiver.type === "call") {
      isLink.add(receiver.id);
    }
  }
  return calls.filter((call) => !isLink.has(call.id));
}

/**
 * The calls a reader reports, out of everything a body writes: one per
 * chain, plus the no-argument calls `keeps` says are calls rather than
 * property reads. A no-argument call does not take the place of the
 * call it is written on, because `Filter.new(a, b).results` runs the
 * class's `initialize` and then its `results`, and a reader that
 * reported only the outermost of the two would never reach the first.
 */
export function callsReported(
  written: readonly RbNode[],
  keeps: (call: RbNode) => boolean,
): RbNode[] {
  const outermost = new Set(
    withoutChainLinks(
      written.filter((call) => !isArglessReceiverCall(call)),
    ).map((call) => call.id),
  );
  return written.filter((call) =>
    isArglessReceiverCall(call) ? keeps(call) : outermost.has(call.id),
  );
}

/**
 * The method name a call spells. A bare call is an identifier and
 * spells its own name. The `.()` shorthand has no `method` field, and
 * its only other children are the receiver and the argument list, so
 * without the middle branch the fallback would read the receiver's own
 * text as the method name.
 */
export function calleeMethodName(call: RbNode): string | undefined {
  if (call.type === "identifier") {
    return call.text;
  }
  const method = field(call, "method");
  if (method !== null) {
    return method.text;
  }
  return field(call, "receiver") !== null ? "call" : children(call)[0]?.text;
}

/**
 * A call written on a receiver with no argument list. Ruby has no
 * property read, so `config.host` and `c.run` are the same node, and
 * which one this is depends on what the receiver turns out to be. That
 * is what the mark is for: `bodyCalls` keeps these, and each reader
 * decides for itself which of them count. `handler.call` is left out,
 * because it runs the Proc the receiver refers to rather than a method
 * looked up on it, and the walk settles that one through the caller.
 */
export function isArglessReceiverCall(node: RbNode): boolean {
  if (field(node, "receiver") === null || field(node, "arguments") !== null) {
    return false;
  }
  return calleeMethodName(node) !== "call";
}

function isRaise(node: RbNode): boolean {
  const method = field(node, "method") ?? children(node)[0] ?? null;
  return (
    field(node, "receiver") === null &&
    method !== null &&
    RAISE_NAMES.has(method.text)
  );
}

/** The methods a pack declared the library defines itself, so a receiverless call to one of them is not work the project does. */
export type InheritedMethods = ReadonlySet<string>;

const NO_INHERITED_METHODS: InheritedMethods = new Set<string>();

/** What a reader with no walk behind it makes of a no-argument call. */
const NO_ARGLESS_CALLS = (): boolean => false;

/** Every no-argument call, for a reader whose list the walk finishes. */
export const EVERY_ARGLESS_CALL = (): boolean => true;

/** Whether this call goes with no receiver to a method the library defines, which is how a body writes one. */
function isInherited(node: RbNode, inherited: InheritedMethods): boolean {
  const method = field(node, "method");
  return (
    field(node, "receiver") === null &&
    method !== null &&
    inherited.has(method.text)
  );
}

function isCall(
  node: RbNode,
  locals: ReadonlySet<string>,
  inherited: InheritedMethods,
): boolean {
  if (node.type === "call") {
    return !isRaise(node) && !isInherited(node, inherited);
  }
  return (
    isBareMethodCall(node, locals) &&
    !RAISE_NAMES.has(node.text) &&
    !inherited.has(node.text)
  );
}

function collectCalls(
  node: RbNode,
  locals: ReadonlySet<string>,
  inherited: InheritedMethods,
  found: RbNode[],
): RbNode[] {
  for (const child of children(node)) {
    if (OWN_BODY_TYPES.has(child.type)) {
      continue;
    }
    if (isCall(child, locals, inherited)) {
      found.push(child);
    }
    collectCalls(child, locals, inherited, found);
  }
  return found;
}

/**
 * Every call this method's own body makes. A raise is not one, and
 * neither is a call to a method a pack said the library defines. A call
 * written with no arguments is in here, and `isArglessReceiverCall`
 * marks it so each reader can decide whether it counts.
 */
export function bodyCalls(
  definitionNode: RbNode,
  inherited: InheritedMethods = NO_INHERITED_METHODS,
): RbNode[] {
  const body = field(definitionNode, "body");
  if (body === null) {
    return [];
  }
  return collectCalls(body, localNamesIn(definitionNode), inherited, []);
}

/** The callee as it is written, which is what a reader matches against. */
export function calleeText(call: RbNode): string {
  const receiver = field(call, "receiver");
  const method = calleeMethodName(call);
  if (method === undefined) {
    return call.text;
  }

  return receiver === null ? method : `${receiver.text}.${method}`;
}

function argOf(node: RbNode, facts: Database | undefined): EffectArg {
  const literal = literalArgOf(node, facts);
  if (literal !== null) {
    return literal;
  }
  if (node.type === "call" && !isArglessReceiverCall(node)) {
    return {
      kind: "call",
      callee: calleeText(node),
      args: argsOf(node, facts),
    };
  }
  return { kind: "identifier", name: node.text };
}

function argsOf(call: RbNode, facts: Database | undefined): EffectArg[] {
  const args = field(call, "arguments");
  if (args === null) {
    return [];
  }
  return children(args).map((child) =>
    child.type === "pair"
      ? argOf(field(child, "value") ?? child, facts)
      : argOf(child, facts),
  );
}

/** The statement a call is written in, which is the node the lowering keys on. */
function enclosingStatement(call: RbNode, body: RbNode): RbNode {
  let current: RbNode = call;
  while (current.parent !== null) {
    if (BLOCK_TYPES.has(current.parent.type) || current.parent.id === body.id) {
      return current;
    }
    current = current.parent;
  }
  return current;
}

/**
 * The calls a body makes, each with the conditions that have to be true for
 * it to run. A call nobody gated says so by recording no preconditions, which
 * the IR reads as always firing.
 *
 * `keepsArglessCall` says which calls written with no arguments count.
 * Ruby writes a property read the same way it writes such a call, and
 * only the reach walk settles which one a given expression is, so a
 * caller that the walk finishes for keeps them all and one with no walk
 * behind it keeps none.
 */
export function invocationEffects(
  definitionNode: RbNode,
  inherited: InheritedMethods = NO_INHERITED_METHODS,
  keepsArglessCall: (call: RbNode) => boolean = NO_ARGLESS_CALLS,
  facts?: Database | undefined,
): InvocationEffect[] {
  const body = field(definitionNode, "body");
  if (body === null) {
    return [];
  }

  const calls = callsReported(
    bodyCalls(definitionNode, inherited),
    keepsArglessCall,
  );
  if (calls.length === 0) {
    return [];
  }

  // Two calls written in one statement, `Filter.new(a).results`, give
  // two readings of that statement, and the engine keys a path by the
  // node it was handed, so both calls have to be handed the same one.
  const statementOf = new Map<number, RbNode>();
  const byStatement = new NodeMap<RbNode>();
  const statements: RbNode[] = [];
  for (const call of calls) {
    const written = enclosingStatement(call, body);
    const statement = byStatement.get(written);
    if (statement === undefined) {
      byStatement.set(written, written);
      statements.push(written);
    }
    statementOf.set(call.id, statement ?? written);
  }

  const lowered = lowerRubyBody(body, statements);
  const enumerated = enumerateOrDegrade(
    {
      statements: lowered.statements,
      terminalsByStmt: lowered.terminalsByStmt,
    },
    statements,
  );

  return calls.map((call) => {
    const statement = statementOf.get(call.id);
    const conditions = sharedGatingConditions(
      statement === undefined
        ? undefined
        : enumerated.byTerminal.get(statement),
    );
    return {
      type: "invocation",
      callee: calleeText(call),
      args: argsOf(call, facts),
      async: false,
      ...(conditions.length > 0 ? { preconditions: conditions } : {}),
    };
  });
}
