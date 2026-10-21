/**
 * continuation.ts: the call a wrapper makes to hand control on.
 *
 * A middleware takes a unit and returns a unit, and the call to its
 * continuation parameter is where the wrapped unit runs. Matching that
 * call as a terminal splits the wrapper's paths in two: the ones that
 * reach the continuation, which composition splices the wrapped unit
 * into, and the ones that respond first, which stand on their own.
 *
 * Nothing declares this terminal in a pack. The adapter builds it from
 * `DiscoveryPattern.wraps.continuationParam`.
 */

import { Node } from "ts-morph";

import { findEnclosingFunction } from "../discovery/shared.js";
import { endLineOf, startLineOf } from "../lines.js";
import { parameterPositionOf, returnPositionOf } from "./shared.js";

import type { RawTerminal, TerminalPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { FoundTerminal } from "./shared.js";

export function tryMatchParameterCall(
  node: Node,
  func: FunctionRoot,
  pattern: TerminalPattern,
  match: Extract<TerminalPattern["match"], { type: "parameterCall" }>,
): FoundTerminal | null {
  if (!Node.isCallExpression(node)) {
    return null;
  }

  const owner =
    match.ofEnclosingFunction === true ? findEnclosingFunction(func) : func;
  const callee = node.getExpression();
  if (
    owner === null ||
    parameterPositionOf(callee, owner) !== match.parameterPosition
  ) {
    return null;
  }

  const terminal: RawTerminal = {
    kind: pattern.kind,
    statusCode: null,
    body: null,
    exceptionType: null,
    message: null,
    component: null,
    delegateTarget: callee.getText(),
    emitEvent: null,
    renderTree: null,
    location: { start: startLineOf(node), end: endLineOf(node) },
  };

  // `return next()` hands the request on, so the return is read.
  const source = returnPositionOf(node);
  return source === null ? { node, terminal } : { node, terminal, source };
}
