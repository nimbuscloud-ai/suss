/**
 * The calls a unit's own body makes, as invocation effects, wherever a
 * call is written: as a statement, as an argument, or as the receiver of
 * a method chain. A call written under an `if` gets that test as a
 * precondition, and the IR reads an effect with preconditions as one
 * that does not always run. The walk goes into lambdas, whose calls count
 * as the enclosing unit's, and stops at a nested `def`, whose calls go on
 * its own summary.
 */

import { enumerateOrDegrade, sharedGatingConditions } from "@suss/extractor";
import { constantOf, literalOf } from "@suss/values";

import { field, runsAtModuleLoad } from "../ast.js";
import { askWrittenValues, evaluatedValue } from "../values/evaluator.js";
import { lowerPythonBody } from "./lowering.js";
import { predicateOf } from "./predicates.js";

import type { Database } from "@suss/datalog";
import type { ConditionInfo, EffectArg, RawEffect } from "@suss/extractor";
import type { PyNode } from "../parser.js";

/** A lambda is left out on purpose, because its calls count as the enclosing unit's. */
const NESTED_DEFINITION_TYPES = new Set(["function_definition"]);

/** The literal an argument evaluates to, or null when it does not settle on one. */
function literalArgOf(
  node: PyNode,
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

/** Every call written in this function's own body, in source order. */
export function bodyCalls(node: PyNode, found: PyNode[] = []): PyNode[] {
  for (const child of node.namedChildren) {
    if (child === null || NESTED_DEFINITION_TYPES.has(child.type)) {
      continue;
    }
    if (child.type === "call") {
      found.push(child);
    }
    bodyCalls(child, found);
  }
  return found;
}

/** Every call the module makes as it loads, in source order. */
export function moduleLoadCalls(node: PyNode, found: PyNode[] = []): PyNode[] {
  for (const child of node.namedChildren) {
    if (child === null || !runsAtModuleLoad(child)) {
      continue;
    }
    if (child.type === "call") {
      found.push(child);
    }
    moduleLoadCalls(child, found);
  }
  return found;
}

/** The statement a call is written in, which is the node the lowering keys on. */
export function enclosingStatement(call: PyNode, body: PyNode): PyNode | null {
  let current: PyNode | null = call;
  while (current !== null && current.parent !== null) {
    if (current.parent.type === "block" || current.parent.id === body.id) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/** The argument's literal when it settles on one, otherwise the call or name as written. */
function argOf(node: PyNode, facts: Database | undefined): EffectArg {
  const literal = literalArgOf(node, facts);
  if (literal !== null) {
    return literal;
  }
  if (node.type === "call") {
    return {
      kind: "call",
      callee: calleeText(node),
      args: argsOf(node, facts),
    };
  }
  return { kind: "identifier", name: node.text };
}

/** The expression each argument states, with a keyword argument read through to the value it writes. */
function argumentNodes(call: PyNode): PyNode[] {
  const args = field(call, "arguments");
  if (args === null) {
    return [];
  }
  return args.namedChildren
    .filter((child): child is PyNode => child !== null)
    .map((child) =>
      child.type === "keyword_argument"
        ? (field(child, "value") ?? child)
        : child,
    );
}

function argsOf(call: PyNode, facts: Database | undefined): EffectArg[] {
  return argumentNodes(call).map((node) => argOf(node, facts));
}

/** The callee as written. Readers of the effect match on this text. */
export function calleeText(call: PyNode): string {
  return field(call, "function")?.text ?? call.text;
}

/**
 * The calls a body makes, each with the conditions that have to be true for
 * it to run. An ungated call gets no preconditions, and the IR reads that as
 * a call that always runs.
 */
export function invocationEffects(
  definitionNode: PyNode,
  facts?: Database | undefined,
): Extract<RawEffect, { type: "invocation" }>[] {
  const body = field(definitionNode, "body");
  if (body === null) {
    return [];
  }
  return invocationEffectsIn(body, bodyCalls(body), facts);
}

/**
 * The same, for the statements a module runs as it loads. A module has no
 * body field, so the module node is passed where a body would be.
 */
export function moduleLoadInvocationEffects(
  moduleNode: PyNode,
  facts?: Database | undefined,
): Extract<RawEffect, { type: "invocation" }>[] {
  return invocationEffectsIn(moduleNode, moduleLoadCalls(moduleNode), facts);
}

/** The evaluator asks the rules about a name, a member read or a call, and works out anything else from its parts. */
const ASKED_ABOUT_TYPES = new Set(["identifier", "attribute", "call"]);

/** Every node under this expression that an evaluation of it could ask the rules about. */
function askedNodesUnder(node: PyNode, found: PyNode[] = []): PyNode[] {
  if (ASKED_ABOUT_TYPES.has(node.type)) {
    found.push(node);
  }
  for (const child of node.namedChildren) {
    if (child !== null && !NESTED_DEFINITION_TYPES.has(child.type)) {
      askedNodesUnder(child, found);
    }
  }
  return found;
}

/**
 * Every value this body's own effects could ask the rules about, so a
 * caller can settle all of a file's bodies in one question. A nested `def`
 * is left out, because its body goes on its own summary and is settled
 * when that summary is read.
 */
export function bodyValueNodes(definitionNode: PyNode): PyNode[] {
  const body = field(definitionNode, "body");
  return body === null ? [] : askedNodesUnder(body);
}

/** The value nodes one call's effect reads: what it is passed, and what the conditions gating it compare. */
function effectValueNodes(
  call: PyNode,
  gating: readonly (readonly ConditionInfo<PyNode>[])[] | undefined,
): PyNode[] {
  const found = argumentNodes(call).flatMap((node) => askedNodesUnder(node));
  for (const path of gating ?? []) {
    for (const condition of path) {
      if (condition.expression !== null) {
        askedNodesUnder(condition.expression, found);
      }
    }
  }
  return found;
}

function invocationEffectsIn(
  body: PyNode,
  written: readonly PyNode[],
  facts: Database | undefined,
): Extract<RawEffect, { type: "invocation" }>[] {
  // A call finishes after everything written inside it, so ordering by end
  // puts a call in argument position before the call it feeds.
  const calls = [...written].sort((a, b) => a.endIndex - b.endIndex);
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

  const gatingOf = calls.map((call) => {
    const statement = statementOf.get(call.id);
    return statement === undefined
      ? undefined
      : enumerated.byTerminal.get(statement);
  });

  // The rules run over the whole project's facts, so this body settles
  // every value it is about to read in one question rather than one per
  // argument and one per condition.
  askWrittenValues(
    calls.flatMap((call, index) => effectValueNodes(call, gatingOf[index])),
    facts,
  );

  return calls.map((call, index) => {
    const conditions = sharedGatingConditions(gatingOf[index], (condition) =>
      predicateOf(condition, facts),
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
