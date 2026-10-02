/**
 * Reads a project function a client caller hands its response to as part
 * of the caller.
 *
 *   resp = requests.get(url)
 *   return check_response(resp)
 *
 * `check_response` raises on a failed status. Read alone, the caller tests
 * nothing, so every failure looks unhandled. The rules settle which
 * function the call runs, the helper's paths are read the way the
 * caller's were, and a test on its parameter becomes a test on the
 * caller's variable. A helper that never tests what it got is left alone.
 */

import { helperPathsOnVariables, splitAtHandOffs } from "@suss/extractor";

import { field, rangeOf } from "./ast.js";
import { callArguments, parameterShapes } from "./facts/values.js";
import { calledDefinition, writtenNodeOf } from "./values/evaluator.js";
import { isMethod } from "./values/lowering.js";

import type { Database } from "@suss/datalog";
import type { HandOffSite, RawBranch } from "@suss/extractor";
import type { PyNode } from "./parser.js";
import type { InvocationSite } from "./paths/effects.js";

export interface HandOffOptions {
  /** The request call whose response the caller has. */
  request: PyNode;
  /** The response's methods that parse its body, as the pack lists them. */
  bodyMethods: readonly string[];
  facts: Database | undefined;
  /** The helper's paths, read the way the caller's are. */
  readHelper: (helper: PyNode) => RawBranch[];
}

/**
 * The caller's branches, each split at every call on it that hands the
 * response to a helper.
 */
export function throughResponseHelpers(
  branches: readonly RawBranch[],
  sites: readonly InvocationSite[],
  options: HandOffOptions,
): RawBranch[] {
  const handOffs: HandOffSite[] = [];
  for (const { call, effect } of sites) {
    const helper = helperBranchesAt(call, options);
    if (helper !== null) {
      handOffs.push({
        helper,
        preconditions: effect.preconditions,
        line: rangeOf(call).start,
        at: rangeOf(call),
      });
    }
  }
  return handOffs.length === 0
    ? [...branches]
    : branches.flatMap((branch) => splitAtHandOffs(branch, handOffs));
}

function helperBranchesAt(
  call: PyNode,
  options: HandOffOptions,
): RawBranch[] | null {
  const handed = callArguments(call).filter(
    (argument) =>
      argument.node.type === "identifier" &&
      refersToResponse(argument.node, options),
  );
  if (handed.length === 0) {
    return null;
  }
  const helper = calledDefinition(call, options.facts);
  if (helper === null || helper.type !== "function_definition") {
    return null;
  }

  // Parameter name to the caller's variable for what it was handed.
  const passed = new Map<string, string>();
  const parameters = parameterShapes(helper, isMethod(helper) ? 1 : 0);
  for (const argument of handed) {
    const parameter = parameters.find((one) =>
      argument.kind === "positional"
        ? one.position === argument.position
        : one.name === argument.name,
    );
    if (parameter !== undefined) {
      passed.set(parameter.name, argument.node.text);
    }
  }
  return passed.size === 0
    ? null
    : helperPathsOnVariables(options.readHelper(helper), passed);
}

/** Whether a variable refers to the response, or to the body one of the pack's methods parsed from it. */
function refersToResponse(name: PyNode, options: HandOffOptions): boolean {
  const written = awaited(writtenNodeOf(name, options.facts));
  if (written === null) {
    return false;
  }
  if (sameNode(written, options.request)) {
    return true;
  }
  const callee = written.type === "call" ? field(written, "function") : null;
  const method = callee === null ? null : field(callee, "attribute");
  const receiver = callee === null ? null : field(callee, "object");
  if (
    method === null ||
    receiver?.type !== "identifier" ||
    !options.bodyMethods.includes(method.text)
  ) {
    return false;
  }
  const parsedFrom = awaited(writtenNodeOf(receiver, options.facts));
  return parsedFrom !== null && sameNode(parsedFrom, options.request);
}

function awaited(node: PyNode | null): PyNode | null {
  return node?.type === "await" ? (node.namedChild(0) ?? null) : node;
}

function sameNode(a: PyNode, b: PyNode): boolean {
  return (
    a.startIndex === b.startIndex &&
    a.endIndex === b.endIndex &&
    a.tree === b.tree
  );
}
