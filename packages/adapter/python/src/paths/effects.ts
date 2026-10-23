/**
 * The calls a unit's own body makes, as invocation effects, wherever a
 * call is written: as a statement, as an argument, or as the receiver of
 * a method chain. A call written under an `if` gets that test as a
 * precondition, and the IR reads an effect with preconditions as one
 * that does not always run. The walk goes into lambdas, whose calls count
 * as the enclosing unit's, and stops at a nested `def`, whose calls go on
 * its own summary.
 */

import { sharedGatingConditions, statementSites } from "@suss/extractor";
import { constantOf, literalOf } from "@suss/values";

import { children, field, rangeOf, runsAtModuleLoad } from "../ast.js";
import { guardInputs } from "../provenance.js";
import { askWrittenValues, evaluatedValue } from "../values/evaluator.js";
import { lowerPythonBody } from "./lowering.js";
import { type GuardInputs, operandsOf, predicateOf } from "./predicates.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  ConditionInfo,
  EffectArg,
  EffectSite,
  PlacedEffect,
  RawEffect,
  StatementSites,
} from "@suss/extractor";
import type { PyNode } from "../parser.js";

/** A lambda is left out on purpose, because its calls count as the enclosing unit's. */
const NESTED_DEFINITION_TYPES = new Set(["function_definition"]);

/** The literal an argument evaluates to, or null when it does not settle on one. */
function literalArgOf(
  node: PyNode,
  facts: Database | undefined,
): EffectArg | null {
  // The evaluator can settle a name on None when it lost track of the other values, so only a written None counts.
  if (node.type === "none") {
    return { kind: "null" };
  }
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
  for (const child of children(node)) {
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
  for (const child of children(node)) {
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
  return children(args).map((child) =>
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
): InvocationEffect[] {
  return invocationSites(definitionNode, facts).map((site) => site.effect);
}

type InvocationEffect = Extract<RawEffect, { type: "invocation" }>;

/** An effect a reader built from the source, and the node it built it from. */
export interface EffectAt {
  effect: Effect;
  at: PyNode;
}

/** One call a body makes, beside the effect recorded for it and where it is written. */
export interface InvocationSite extends PlacedEffect<InvocationEffect> {
  call: PyNode;
}

/** The same, keeping each effect's call, for a reader that has to go back to it. */
export function invocationSites(
  definitionNode: PyNode,
  facts?: Database | undefined,
): InvocationSite[] {
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
): InvocationEffect[] {
  return invocationEffectsIn(
    moduleNode,
    moduleLoadCalls(moduleNode),
    facts,
  ).map((site) => site.effect);
}

/** The evaluator asks the rules about a name, a member read or a call, and works out anything else from its parts. */
const ASKED_ABOUT_TYPES = new Set(["identifier", "attribute", "call"]);

/** Every node under this expression that an evaluation of it could ask the rules about. */
function askedNodesUnder(node: PyNode, found: PyNode[] = []): PyNode[] {
  if (ASKED_ABOUT_TYPES.has(node.type)) {
    found.push(node);
  }
  for (const child of children(node)) {
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

/**
 * The input each subject of the conditions gating a body's calls reads,
 * asked once for the body. Code at module level belongs to no function,
 * so nothing it tests is an input.
 */
function gatingInputs(
  body: PyNode,
  gatingOf: ReadonlyArray<readonly ConditionInfo<PyNode>[][] | undefined>,
  facts: Database | undefined,
): GuardInputs | undefined {
  const unit = body.parent;
  if (facts === undefined || unit === null) {
    return undefined;
  }
  const operands = gatingOf.flatMap((paths) =>
    (paths ?? []).flatMap((path) =>
      path.flatMap((condition) =>
        condition.expression === null ? [] : operandsOf(condition.expression),
      ),
    ),
  );
  return operands.length === 0
    ? undefined
    : guardInputs(operands, { facts, unit });
}

/** The paths to the statement each of these nodes is written in, and where each one is. */
function sitesIn(
  body: PyNode,
  nodes: readonly PyNode[],
): StatementSites<PyNode, PyNode> {
  return statementSites(nodes, {
    statementOf: (node) => enclosingStatement(node, body),
    lower: (statements) => lowerPythonBody(body, statements),
    firstLine: (node) => rangeOf(node).start,
  });
}

/**
 * Where each of these nodes is written in the body, for an effect a pack
 * recognized at one of them to be placed on branches by.
 */
export function effectSitesIn(
  body: PyNode | null,
  nodes: readonly PyNode[],
): (node: PyNode) => EffectSite {
  if (body === null || nodes.length === 0) {
    return (node) => ({ line: rangeOf(node).start });
  }
  return sitesIn(body, nodes).plainSiteOf;
}

function invocationEffectsIn(
  body: PyNode,
  written: readonly PyNode[],
  facts: Database | undefined,
): InvocationSite[] {
  // A call finishes after everything written inside it, so ordering by end
  // puts a call in argument position before the call it feeds.
  const calls = [...written].sort((a, b) => a.endIndex - b.endIndex);
  if (calls.length === 0) {
    return [];
  }

  const sites = sitesIn(body, calls);
  const gatingOf = calls.map((call) => sites.pathsTo(call));

  // The rules run over the whole project's facts, so this body settles
  // every value it is about to read in one question rather than one per
  // argument and one per condition.
  askWrittenValues(
    calls.flatMap((call, index) => effectValueNodes(call, gatingOf[index])),
    facts,
  );
  const inputs = gatingInputs(body, gatingOf, facts);

  return calls.map((call, index) => {
    const conditions = sharedGatingConditions(gatingOf[index], (condition) =>
      predicateOf(condition, facts, inputs),
    );
    return {
      call,
      effect: {
        type: "invocation",
        callee: calleeText(call),
        args: argsOf(call, facts),
        async: false,
        ...(conditions.length > 0 ? { preconditions: conditions } : {}),
        location: rangeOf(call),
      },
      site: sites.siteOf(call, conditions),
    };
  });
}
