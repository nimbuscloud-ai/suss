// effects.ts: the calls a route's own body makes, as invocation effects.
// A call written under an `if` records that test as a precondition, which is
// what the IR means by a call that does not always fire.

import { enumerateOrDegrade, sharedGatingConditions } from "@suss/extractor";

import { field } from "../ast.js";
import { lowerPythonBody } from "./lowering.js";
import { predicateOf } from "./predicates.js";

import type { EffectArg, RawEffect } from "@suss/extractor";
import type { PyNode } from "../parser.js";

/** A body written in one of these belongs to the function it declares. */
const NESTED_FUNCTION_TYPES = new Set(["function_definition", "lambda"]);

const LITERAL_ARGS: Record<string, (node: PyNode) => EffectArg | null> = {
  string: (node) => ({ kind: "string", value: node.text.slice(1, -1) }),
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
};

/** Every call written in this function's own body, in source order. */
export function bodyCalls(node: PyNode, found: PyNode[] = []): PyNode[] {
  for (const child of node.namedChildren) {
    if (child === null || NESTED_FUNCTION_TYPES.has(child.type)) {
      continue;
    }
    if (child.type === "call") {
      found.push(child);
    }
    bodyCalls(child, found);
  }
  return found;
}

/** The statement a call is written in, which is the node the lowering keys on. */
function enclosingStatement(call: PyNode, body: PyNode): PyNode | null {
  let current: PyNode | null = call;
  while (current !== null && current.parent !== null) {
    if (current.parent.type === "block" || current.parent.id === body.id) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/** What one argument says, written out as the IR spells an effect argument. */
function argOf(node: PyNode): EffectArg {
  const literal = LITERAL_ARGS[node.type]?.(node);
  if (literal !== null && literal !== undefined) {
    return literal;
  }
  if (node.type === "call") {
    return { kind: "call", callee: calleeText(node), args: argsOf(node) };
  }
  return { kind: "identifier", name: node.text };
}

function argsOf(call: PyNode): EffectArg[] {
  const args = field(call, "arguments");
  if (args === null) {
    return [];
  }
  return args.namedChildren
    .filter((child): child is PyNode => child !== null)
    .map((child) =>
      child.type === "keyword_argument"
        ? argOf(field(child, "value") ?? child)
        : argOf(child),
    );
}

/** The callee as it is written, which is what a reader matches against. */
function calleeText(call: PyNode): string {
  return field(call, "function")?.text ?? call.text;
}

/**
 * The calls a body makes, each with the conditions that have to be true for
 * it to run. A call nobody gated says so by carrying no preconditions, which
 * the IR reads as always firing.
 */
/**
 * One invocation per chain. `Model.query().filter_by(x).first()` is one thing
 * the code does, and the outermost call's text spells out the whole chain, so
 * emitting the inner links too counts the same work three times.
 */
function withoutChainLinks(calls: readonly PyNode[]): PyNode[] {
  const isLink = new Set<number>();
  for (const call of calls) {
    const callee = field(call, "function");
    if (callee === null || callee.type !== "attribute") {
      continue;
    }
    const object = field(callee, "object");
    if (object !== null && object.type === "call") {
      isLink.add(object.id);
    }
  }
  return calls.filter((call) => !isLink.has(call.id));
}

export function invocationEffects(
  definitionNode: PyNode,
): Extract<RawEffect, { type: "invocation" }>[] {
  const body = field(definitionNode, "body");
  if (body === null) {
    return [];
  }

  const calls = withoutChainLinks(bodyCalls(body));
  if (calls.length === 0) {
    return [];
  }

  // A call is an expression inside a statement, and the lowering keys paths by
  // statement, so each call is asked about through the statement it is in.
  const statementOf = new Map<number, PyNode>();
  const statements: PyNode[] = [];
  for (const call of calls) {
    const statement = enclosingStatement(call, body);
    if (statement === null) {
      continue;
    }
    statementOf.set(call.id, statement);
    statements.push(statement);
  }

  const lowered = lowerPythonBody(body, statements);
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
      predicateOf,
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
