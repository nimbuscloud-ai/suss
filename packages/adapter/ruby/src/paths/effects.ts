/**
 * The calls a body makes, as invocation effects. A call written under an
 * `if` records that test as a precondition, and the IR treats a call
 * with preconditions as one that does not always run.
 */

import { enumerateOrDegrade, sharedGatingConditions } from "@suss/extractor";
import { constantOf, literalOf } from "@suss/values";

import { field, MODULE_SCOPE_STOPS, NodeMap, OWN_BODY_TYPES } from "../ast.js";
import { evaluatedValue } from "../values/evaluator.js";
import { isBareMethodCall, localNamesIn } from "./bareCalls.js";
import { lowerRubyBody } from "./lowering.js";

import type { Database } from "@suss/datalog";
import type { EffectArg, RawEffect } from "@suss/extractor";
import type { RbNode } from "../parser.js";

type InvocationEffect = Extract<RawEffect, { type: "invocation" }>;

/** `raise` is a call in Ruby, but it leaves the method instead of doing work. */
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
 * One invocation per chain. `Order.where(id: 1).limit(10).update(...)` is
 * one operation, and the outermost call's text already shows the whole
 * chain. Emitting the inner links too would count the same work three
 * times.
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
 * The calls to report out of everything a body writes: one per chain,
 * plus the calls with no arguments that `keeps` accepts as calls instead
 * of property reads. A call with no arguments does not replace the call
 * it is written on. `Filter.new(a, b).results` runs the class's
 * `initialize` and then its `results`, and reporting only the outer call
 * would lose the first.
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
 * The method name a call invokes. A bare call is an identifier, and its
 * text is the name. The `.()` shorthand has no `method` field, so it is
 * reported as `call`; without that branch the fallback would take the
 * receiver's text as the method name.
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
 * Whether a call has a receiver and no argument list. Ruby has no
 * separate syntax for a property read, so `config.host` and `c.run`
 * parse the same way, and which one a call is depends on what its
 * receiver turns out to be. `bodyCalls` keeps these calls, and each
 * reader decides which of them count. `handler.call` is excluded,
 * because it runs the Proc the receiver refers to, and the walk resolves
 * it through the caller.
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

/** Methods the pack says the library defines, so a receiverless call to one of them is not project work. */
export type InheritedMethods = ReadonlySet<string>;

const NO_INHERITED_METHODS: InheritedMethods = new Set<string>();

/** For a reader with no reach walk behind it, no call without arguments counts. */
const NO_ARGLESS_CALLS = (): boolean => false;

/** For a reader whose list the reach walk finishes, every call without arguments counts until the walk removes the property reads. */
export const EVERY_ARGLESS_CALL = (): boolean => true;

/** Whether this is a receiverless call to a method the library defines. */
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
  read: ReadableBody,
  inherited: InheritedMethods,
  found: RbNode[],
): RbNode[] {
  for (const child of children(node)) {
    if (read.stops.has(child.type)) {
      continue;
    }
    if (isCall(child, read.locals, inherited)) {
      found.push(child);
    }
    collectCalls(child, read, inherited, found);
  }
  return found;
}

/** The statements a reader walks, the names that are locals in them, and the child types whose statements belong to something else. */
export interface ReadableBody {
  readonly body: RbNode;
  readonly locals: ReadonlySet<string>;
  readonly stops: ReadonlySet<string>;
}

/** A method's own body to read, or null when the method has none. */
export function methodBody(definitionNode: RbNode): ReadableBody | null {
  const body = field(definitionNode, "body");
  if (body === null) {
    return null;
  }
  return {
    body,
    locals: localNamesIn(definitionNode),
    stops: OWN_BODY_TYPES,
  };
}

/** What a file runs as it loads: the statements written outside every definition and every block. */
export function moduleScopeBody(root: RbNode): ReadableBody {
  return {
    body: root,
    locals: localNamesIn(root, MODULE_SCOPE_STOPS),
    stops: MODULE_SCOPE_STOPS,
  };
}

/**
 * Every call this body makes. A raise does not count, and neither does a
 * call to a method the pack says the library defines. Calls with no
 * arguments are included, and `isArglessReceiverCall` identifies them so
 * each reader can decide whether they count.
 */
export function bodyCalls(
  read: ReadableBody,
  inherited: InheritedMethods = NO_INHERITED_METHODS,
): RbNode[] {
  return collectCalls(read.body, read, inherited, []);
}

/** The callee as written, for a reader to match against. */
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
 * The calls a body makes, each with the conditions that must hold for it
 * to run. A call with no gate has no preconditions, and the IR treats it
 * as always running.
 *
 * `keepsArglessCall` decides which calls with no arguments count. Ruby
 * writes a property read the same way, and only the reach walk settles
 * which one an expression is. A caller whose list the walk finishes
 * keeps them all, and a caller with no walk keeps none.
 */
export function invocationEffects(
  definitionNode: RbNode,
  inherited: InheritedMethods = NO_INHERITED_METHODS,
  keepsArglessCall: (call: RbNode) => boolean = NO_ARGLESS_CALLS,
  facts?: Database | undefined,
): InvocationEffect[] {
  const read = methodBody(definitionNode);
  if (read === null) {
    return [];
  }
  return effectsOfBody(read, inherited, keepsArglessCall, facts);
}

/** The same, for the statements a file runs as it loads. */
export function moduleScopeInvocationEffects(
  root: RbNode,
  inherited: InheritedMethods = NO_INHERITED_METHODS,
  keepsArglessCall: (call: RbNode) => boolean = NO_ARGLESS_CALLS,
  facts?: Database | undefined,
): InvocationEffect[] {
  return effectsOfBody(
    moduleScopeBody(root),
    inherited,
    keepsArglessCall,
    facts,
  );
}

function effectsOfBody(
  read: ReadableBody,
  inherited: InheritedMethods,
  keepsArglessCall: (call: RbNode) => boolean,
  facts: Database | undefined,
): InvocationEffect[] {
  const body = read.body;
  const calls = callsReported(bodyCalls(read, inherited), keepsArglessCall);
  if (calls.length === 0) {
    return [];
  }

  // `Filter.new(a).results` puts two calls in one statement. The engine
  // keys a path by the node it was given, so both calls must map to the
  // same statement node.
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
