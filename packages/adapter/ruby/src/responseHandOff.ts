/**
 * Reads a client caller's own `raise`, and a project method it hands its
 * response to, as part of the caller.
 *
 *   resp = Faraday.get(url)
 *   check_response(resp)
 *
 * `check_response` raises on a failed status. Read alone, the caller tests
 * nothing, so every failure looks unhandled. The rules settle which
 * method the call runs, the helper's paths are read the way the caller's
 * were, and a test on its parameter becomes a test on the caller's
 * variable. A helper that never tests what it got is left alone.
 */

import { helperPathsOnVariables, splitAtHandOffs } from "@suss/extractor";

import { field, rangeOf, readCallArgs, stringLiteralValue } from "./ast.js";
import { parametersOf, paramNameOf } from "./facts/locals.js";
import { escapingRaises, raisedClassRef } from "./raises.js";
import { calledDefinition, writtenNodeOf } from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type { HandOffSite, RawBranch, RawTerminal } from "@suss/extractor";
import type { RbNode } from "./parser.js";
import type { InvocationSite } from "./paths/effects.js";
import type { EndingCall } from "./responseStatus.js";

/** Every raise that leaves the method, each ending it with a throw that claims no status. */
export function raiseEndings(method: RbNode): EndingCall[] {
  return escapingRaises(method).map((call) => ({
    call,
    terminal: raiseTerminal(call),
  }));
}

/** `raise NotFound, "gone"` raises `NotFound`, and `raise "gone"` raises a `RuntimeError`. */
function raiseTerminal(call: RbNode): RawTerminal {
  const [first, second] = readCallArgs(field(call, "arguments")).positional;
  const message = first === undefined ? null : stringLiteralValue(first);
  return {
    kind: "throw",
    statusCode: null,
    body: null,
    exceptionType: raisedClassRef(call, [])?.text ?? null,
    message:
      message ?? (second === undefined ? null : stringLiteralValue(second)),
    component: null,
    renderTree: null,
    delegateTarget: null,
    emitEvent: null,
    location: rangeOf(call),
  };
}

export interface HandOffOptions {
  /** The request call whose response the caller has. */
  request: RbNode;
  /** The response's members that parse its body, as the pack lists them. */
  bodyMethods: readonly string[];
  facts: Database | undefined;
  /** The helper's paths, read the way the caller's are. */
  readHelper: (helper: RbNode) => RawBranch[];
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
  call: RbNode,
  options: HandOffOptions,
): RawBranch[] | null {
  if (call.type !== "call") {
    return null;
  }
  const args = readCallArgs(field(call, "arguments"));
  const handedAt = args.positional.flatMap((argument, position) =>
    argument.type === "identifier" && refersToResponse(argument, options)
      ? [{ position, variable: argument.text }]
      : [],
  );
  const handedAs = Object.entries(args.keyword).flatMap(([name, argument]) =>
    argument.type === "identifier" && refersToResponse(argument, options)
      ? [{ name, variable: argument.text }]
      : [],
  );
  if (handedAt.length === 0 && handedAs.length === 0) {
    return null;
  }
  const helper = calledDefinition(call, options.facts);
  if (helper === null) {
    return null;
  }

  // Parameter name to the caller's variable for what it was handed. The
  // facts count a parameter's position the same way.
  const passed = new Map<string, string>();
  const names = parametersOf(helper).map(
    (parameter) => paramNameOf(parameter)?.text ?? null,
  );
  for (const { position, variable } of handedAt) {
    const name = names[position];
    if (name !== undefined && name !== null) {
      passed.set(name, variable);
    }
  }
  for (const { name, variable } of handedAs) {
    if (names.includes(name)) {
      passed.set(name, variable);
    }
  }
  return passed.size === 0
    ? null
    : helperPathsOnVariables(options.readHelper(helper), passed);
}

/** Whether a variable refers to the response, or to the body one of the pack's members parsed from it. */
function refersToResponse(name: RbNode, options: HandOffOptions): boolean {
  const written = writtenNodeOf(name, options.facts);
  if (written === null) {
    return false;
  }
  if (sameNode(written, options.request)) {
    return true;
  }
  const member = written.type === "call" ? field(written, "method") : null;
  const receiver = written.type === "call" ? field(written, "receiver") : null;
  if (
    member === null ||
    receiver?.type !== "identifier" ||
    !options.bodyMethods.includes(member.text)
  ) {
    return false;
  }
  const parsedFrom = writtenNodeOf(receiver, options.facts);
  return parsedFrom !== null && sameNode(parsedFrom, options.request);
}

function sameNode(a: RbNode, b: RbNode): boolean {
  return (
    a.startIndex === b.startIndex &&
    a.endIndex === b.endIndex &&
    a.tree === b.tree
  );
}
