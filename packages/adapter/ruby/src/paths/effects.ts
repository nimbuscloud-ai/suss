// effects.ts: the calls a resolver's own body makes, as invocation effects.
// A call written under an `if` records that test as a precondition, which is
// what the IR means by a call that does not always fire.

import { enumerateOrDegrade, sharedGatingConditions } from "@suss/extractor";

import { field } from "../ast.js";
import { lowerRubyBody } from "./lowering.js";

import type { EffectArg, RawEffect } from "@suss/extractor";
import type { RbNode } from "../parser.js";

type InvocationEffect = Extract<RawEffect, { type: "invocation" }>;

/** A body written in one of these belongs to the thing it declares. */
const DECLARATION_TYPES = new Set([
  "method",
  "singleton_method",
  "lambda",
  "class",
  "module",
  "singleton_class",
]);

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

const LITERAL_ARGS: Record<string, (node: RbNode) => EffectArg | null> = {
  string: (node) => ({
    kind: "string",
    value: node.text.replace(/^["']|["']$/g, ""),
  }),
  integer: (node) => {
    const value = Number.parseInt(node.text, 10);
    return Number.isNaN(value) ? null : { kind: "number", value };
  },
  float: (node) => {
    const value = Number.parseFloat(node.text);
    return Number.isNaN(value) ? null : { kind: "number", value };
  },
  true: () => ({ kind: "boolean", value: true }),
  false: () => ({ kind: "boolean", value: false }),
  simple_symbol: (node) => ({ kind: "string", value: node.text.slice(1) }),
};

function children(node: RbNode): RbNode[] {
  return node.namedChildren.filter((child): child is RbNode => child !== null);
}

/**
 * One invocation per chain. `Order.where(id: 1).limit(10).update(...)` is one
 * thing the code does, and the outermost call's text spells out the whole
 * chain, so emitting the inner links too counts the same work three times.
 */
function withoutChainLinks(calls: readonly RbNode[]): RbNode[] {
  const isLink = new Set<number>();
  for (const call of calls) {
    const receiver = field(call, "receiver");
    if (receiver !== null && receiver.type === "call") {
      isLink.add(receiver.id);
    }
  }
  return calls.filter((call) => !isLink.has(call.id));
}

/** A receiver call with no arguments reads a property rather than doing work. */
function isPropertyRead(node: RbNode): boolean {
  return field(node, "receiver") !== null && field(node, "arguments") === null;
}

function isRaise(node: RbNode): boolean {
  const method = field(node, "method") ?? children(node)[0] ?? null;
  return (
    field(node, "receiver") === null &&
    method !== null &&
    RAISE_NAMES.has(method.text)
  );
}

/** Every call this method's own body makes, leaving out property reads and raises. */
export function bodyCalls(node: RbNode, found: RbNode[] = []): RbNode[] {
  for (const child of children(node)) {
    if (DECLARATION_TYPES.has(child.type)) {
      continue;
    }
    if (child.type === "call" && !isPropertyRead(child) && !isRaise(child)) {
      found.push(child);
    }
    bodyCalls(child, found);
  }
  return found;
}

/** The callee as it is written, which is what a reader matches against. */
function calleeText(call: RbNode): string {
  const receiver = field(call, "receiver");
  const method = field(call, "method") ?? children(call)[0];
  if (method === undefined) {
    return call.text;
  }

  return receiver === null ? method.text : `${receiver.text}.${method.text}`;
}

function argOf(node: RbNode): EffectArg {
  const literal = LITERAL_ARGS[node.type]?.(node);
  if (literal !== null && literal !== undefined) {
    return literal;
  }
  if (node.type === "call" && !isPropertyRead(node)) {
    return { kind: "call", callee: calleeText(node), args: argsOf(node) };
  }
  return { kind: "identifier", name: node.text };
}

function argsOf(call: RbNode): EffectArg[] {
  const args = field(call, "arguments");
  if (args === null) {
    return [];
  }
  return children(args).map((child) =>
    child.type === "pair"
      ? argOf(field(child, "value") ?? child)
      : argOf(child),
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
 */
export function invocationEffects(definitionNode: RbNode): InvocationEffect[] {
  const body = field(definitionNode, "body");
  if (body === null) {
    return [];
  }

  const calls = withoutChainLinks(bodyCalls(body));
  if (calls.length === 0) {
    return [];
  }

  const statementOf = new Map<number, RbNode>();
  const statements: RbNode[] = [];
  for (const call of calls) {
    const statement = enclosingStatement(call, body);
    statementOf.set(call.id, statement);
    statements.push(statement);
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
      args: argsOf(call),
      async: false,
      ...(conditions.length > 0 ? { preconditions: conditions } : {}),
    };
  });
}
