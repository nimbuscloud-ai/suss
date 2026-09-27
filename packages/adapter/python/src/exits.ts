/**
 * Where a Python body ends the process: `sys.exit(n)`, the builtins
 * `exit(n)` and `quit(n)`, and `raise SystemExit(n)`. Each is an `exit`
 * terminal with the code it passes, the way the Node pack reads
 * `process.exit`. No code exits 0, and a message instead of a code exits
 * 1, as Python does. These are the standard library, so the adapter reads
 * them without a pack.
 *
 * A reached function has one transition, since nothing tells its paths
 * apart. One that ends the process has its paths read one by one
 * instead, so each exit is a transition with the conditions that lead
 * to it.
 */

import {
  markReturnsAsExitCode,
  SKIP_CHILDREN,
  walkDescendants,
} from "@suss/extractor";
import { exitCodeFunctions } from "@suss/resolution";
import { constantOf } from "@suss/values";

import { field, rangeOf, stringLiteralValue } from "./ast.js";
import { callArguments, nodeId } from "./facts/values.js";
import { bodyTerminals, enumerateBodyBranches } from "./paths/bodyBranches.js";
import { returnedBodyShape } from "./paths/returnedShape.js";
import { isBuiltin, isStdlibMember } from "./stdlibNames.js";
import { evaluatedValue } from "./values/evaluator.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawBranch, RawTerminal } from "@suss/extractor";
import type { PyNode } from "./parser.js";
import type { InvocationEffect } from "./paths/bodyBranches.js";
import type { RaisedResponse } from "./paths/raisedResponses.js";
import type { ModuleBinding, Scope } from "./scope.js";

/** One place a body ends the process, and the value it hands over, if any. */
export interface ExitSite {
  statement: PyNode;
  code: PyNode | null;
  /** True for `raise SystemExit(n)`, which the lowering already ends a path at. */
  raised: boolean;
}

/** A nested function ends the process when it is called, so its body waits for its own unit. */
const DEFERRED_BODY_TYPES = new Set(["function_definition", "lambda"]);

/** Every place under `root` that ends the process, `root` itself left out. */
export function exitSites(root: PyNode, module: ModuleBinding): ExitSite[] {
  const found: ExitSite[] = [];
  const startScope = module.scopeFor.get(root.id) ?? module.moduleScope;
  walkDescendants<PyNode, Scope>(root, startScope, {
    at: (node, scope) => {
      const site = exitSiteAt(node, scope);
      if (site !== null) {
        found.push(site);
      }
    },
    into: (node, scope) => {
      if (DEFERRED_BODY_TYPES.has(node.type)) {
        return SKIP_CHILDREN;
      }
      return module.scopeFor.get(node.id) ?? scope;
    },
  });
  return found;
}

function exitSiteAt(statement: PyNode, scope: Scope): ExitSite | null {
  const expression = statement.namedChildren[0] ?? null;
  if (expression === null) {
    return null;
  }
  const call = expression.type === "call" ? expression : null;
  const callee = call === null ? expression : field(call, "function");
  if (callee === null) {
    return null;
  }
  const code = call === null ? null : firstArgument(call);
  if (statement.type === "expression_statement" && call !== null) {
    return endsTheProcess(callee, scope)
      ? { statement, code, raised: false }
      : null;
  }
  if (statement.type === "raise_statement") {
    return isBuiltin(callee, scope, "SystemExit")
      ? { statement, code, raised: true }
      : null;
  }
  return null;
}

function endsTheProcess(callee: PyNode, scope: Scope): boolean {
  return (
    isStdlibMember(callee, scope, "sys", "exit") ||
    isBuiltin(callee, scope, "exit") ||
    isBuiltin(callee, scope, "quit")
  );
}

function firstArgument(call: PyNode): PyNode | null {
  return (
    callArguments(call).find(
      (argument) => argument.kind === "positional" && argument.position === 0,
    )?.node ?? null
  );
}

/** The exit terminal for one site, with the code the call hands over. */
export function exitTerminal(site: ExitSite, facts?: Database): RawTerminal {
  return {
    kind: "exit",
    statusCode: exitCodeOf(site.code, facts),
    body: null,
    exceptionType: null,
    message: null,
    component: null,
    renderTree: null,
    delegateTarget: null,
    emitEvent: null,
    location: rangeOf(site.statement),
  };
}

function exitCodeOf(
  code: PyNode | null,
  facts: Database | undefined,
): RawTerminal["statusCode"] {
  if (code === null || code.type === "none") {
    return { type: "literal", value: 0 };
  }
  if (stringLiteralValue(code) !== null) {
    return { type: "literal", value: 1 };
  }
  const value = constantOf(evaluatedValue(code, facts));
  return typeof value === "number"
    ? { type: "literal", value }
    : { type: "dynamic", sourceText: code.text };
}

/**
 * One branch per path through a reached function that ends the process,
 * the returns and the end of the body included. Null when the function
 * never ends the process, and then it keeps its one transition.
 */
export function exitingBranches(
  definition: PyNode,
  module: ModuleBinding,
  effects: readonly InvocationEffect[],
  facts?: Database,
): RawBranch[] | null {
  const body = field(definition, "body");
  const sites = body === null ? [] : exitSites(definition, module);
  if (sites.length === 0) {
    return null;
  }
  const raised: RaisedResponse[] = sites.map((site) => ({
    statement: site.statement,
    thrownByCall: !site.raised,
    terminal: exitTerminal(site, facts),
  }));
  const range = rangeOf(definition);
  return enumerateBodyBranches({
    body,
    terminals: bodyTerminals(body, raised),
    raised,
    effects,
    facts,
    branchOf: (found) =>
      found.type === "raise"
        ? { terminal: found.terminal, location: found.terminal.location }
        : returnBranch(found.statement),
    fallthrough: {
      terminal: returnTerminal(null, range),
      location: range,
    },
  });
}

/** The places each file ends the process, for the run to ask about once. */
export interface FileExits {
  /** The absolute path, which facts key a node on. */
  file: string;
  sites: readonly ExitSite[];
}

/**
 * Marks each summary whose return becomes the exit code, as
 * `sys.exit(main())` makes `main`'s. The value each exit hands over
 * seeds the same question the TypeScript adapter asks, over this run's
 * facts, and a function a call at or reached from it invokes is marked.
 */
export function markExitCodeFunctions(
  summaries: readonly BehavioralSummary[],
  exits: readonly FileExits[],
  facts: Database,
  workspaceRoot: string | undefined,
): void {
  const sinks = exits.flatMap(({ file, sites }) =>
    sites.flatMap((site) =>
      site.code === null ? [] : [nodeId(file, site.code)],
    ),
  );
  markReturnsAsExitCode(
    summaries,
    exitCodeFunctions(facts, sinks),
    workspaceRoot,
  );
}

function returnBranch(statement: PyNode): {
  terminal: RawTerminal;
  location: RawTerminal["location"];
} {
  const location = rangeOf(statement);
  const shape = returnedBodyShape(statement);
  return { terminal: returnTerminal(shape, location), location };
}

function returnTerminal(
  shape: ReturnType<typeof returnedBodyShape>,
  location: RawTerminal["location"],
): RawTerminal {
  return {
    kind: "return",
    statusCode: null,
    body: shape === null ? null : { typeText: null, shape },
    exceptionType: null,
    message: null,
    component: null,
    renderTree: null,
    delegateTarget: null,
    emitEvent: null,
    location,
  };
}
