/**
 * returnedHelper.ts: a return of a call to a project function that
 * builds the response.
 *
 *   return logAndRespond("Done.", { status: 202 });
 *
 * Nothing at the return matches the pack's `new Response(...)`, which is
 * written inside the helper. The helper is read with the caller's
 * response patterns, its parameters replaced by what this call passed,
 * and each response it builds becomes a response of the caller at the
 * caller's own return. The README says which patterns apply in a helper.
 */

import { Node } from "ts-morph";

import { namesAParameter } from "../discovery/shared.js";
import { endLineOf, startLineOf } from "../lines.js";
import { peelValue } from "../walk/unwrap.js";
import {
  bindArguments,
  branchCanRun,
  type HelperFunction,
  projectFunctionCalled,
  type ResolveCallee,
} from "./helperResolution.js";
import {
  tryMatchFunctionCall,
  tryMatchParameterMethodCall,
} from "./returns.js";
import { parameterPositionOf } from "./shared.js";

import type { TerminalPattern } from "@suss/extractor";
import type { CallExpression, Expression } from "ts-morph";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";
import type { OriginatesFrom } from "../resolve/invocationEffects.js";
import type { FoundTerminal } from "./shared.js";

/** A helper being read for one call: what its parameters were passed, and the functions read on the way to it. */
export interface HelperCall {
  substitutions: ReadonlyMap<string, Expression>;
  reading: readonly Node[];
}

/** What the caller's terminals are read with, so the helper's are read the same way. */
export interface HelperLookups {
  resolution: ResolutionStore | undefined;
  originatesFrom: OriginatesFrom | undefined;
  resolveCallee: ResolveCallee | undefined;
  /** Set when the function being read is itself a helper read for a caller. */
  within?: HelperCall;
}

/** The terminal walk over a helper's body, which the orchestrator passes in. */
export type ReadHelper = (
  helper: HelperFunction,
  patterns: TerminalPattern[],
  call: HelperCall,
) => FoundTerminal[];

/** How many helpers deep a return is followed. */
const MAX_HELPER_DEPTH = 4;

/**
 * The responses a return builds through a project function. Empty when
 * the return is not a call, when one of the caller's own patterns
 * matches the call, or when the function it calls builds no response.
 */
export function tryMatchReturnedHelper(
  node: Node,
  func: FunctionRoot,
  patterns: TerminalPattern[],
  lookups: HelperLookups,
  read: ReadHelper,
): FoundTerminal[] {
  const site = returnedCallAt(node, func);
  const reading = lookups.within?.reading ?? [];
  if (site === null || reading.length >= MAX_HELPER_DEPTH) {
    return [];
  }
  const inHelper = patternsInHelper(patterns, site.call, func);
  // A function the caller was given runs whatever its own caller passed,
  // such as the handler a wrapper calls, which composition splices in.
  if (
    inHelper.length === 0 ||
    namesAParameter(site.call.getExpression()) ||
    matchedWhereWritten(site.call, func, patterns, lookups)
  ) {
    return [];
  }
  const helper = projectFunctionCalled(site.call, lookups.resolveCallee);
  if (helper === null || helper === func || reading.includes(helper)) {
    return [];
  }
  const substitutions = bindArguments(
    site.call.getArguments() as Expression[],
    helper.getParameters(),
    lookups.within?.substitutions,
  );
  const location = {
    start: startLineOf(site.source),
    end: endLineOf(site.source),
  };
  return read(helper, inHelper, { substitutions, reading: [...reading, func] })
    .filter(
      (found) =>
        found.node === helper || branchCanRun(found.node, substitutions),
    )
    .map(({ terminal }) => ({
      node: site.anchor,
      source: site.source,
      terminal: { ...terminal, location },
    }));
}

interface ReturnedCall {
  call: CallExpression;
  /** Where the terminal goes: not on the call, which stays an effect of its own. */
  anchor: Node;
  /** The return the call is handed back from. */
  source: Node;
}

function returnedCallAt(node: Node, func: FunctionRoot): ReturnedCall | null {
  if (Node.isReturnStatement(node)) {
    const written = node.getExpression();
    const value = written === undefined ? undefined : peelValue(written);
    return value !== undefined && Node.isCallExpression(value)
      ? { call: value, anchor: node, source: node }
      : null;
  }
  // A concise arrow returns its body. Its terminal goes on the arrow, the
  // way a return's goes on the statement.
  const body = func.getBody();
  if (
    !Node.isArrowFunction(func) ||
    body === undefined ||
    Node.isBlock(body) ||
    !Node.isCallExpression(node) ||
    peelValue(body) !== node
  ) {
    return null;
  }
  return { call: node, anchor: func, source: body };
}

type InHelper = (
  pattern: TerminalPattern,
  call: CallExpression,
  func: FunctionRoot,
) => TerminalPattern[];

/**
 * How each kind of response pattern applies inside the helper. One on a
 * call by name applies as it is. One on a method of the caller's
 * response parameter applies at each argument where the call passes that
 * parameter, and not at all when the call does not pass it.
 */
const IN_HELPER: Partial<Record<TerminalPattern["match"]["type"], InHelper>> = {
  functionCall: (pattern) => [pattern],
  parameterMethodCall: (pattern, call, func) => {
    const { match } = pattern;
    if (match.type !== "parameterMethodCall") {
      return [];
    }
    return call
      .getArguments()
      .flatMap((argument, position) =>
        parameterPositionOf(peelValue(argument), func) ===
        match.parameterPosition
          ? [{ ...pattern, match: { ...match, parameterPosition: position } }]
          : [],
      );
  },
};

function patternsInHelper(
  patterns: readonly TerminalPattern[],
  call: CallExpression,
  func: FunctionRoot,
): TerminalPattern[] {
  return patterns.flatMap((pattern) =>
    pattern.kind === "response"
      ? (IN_HELPER[pattern.match.type]?.(pattern, call, func) ?? [])
      : [],
  );
}

/** Whether one of the caller's own patterns already matches the call where it is written. */
function matchedWhereWritten(
  call: CallExpression,
  func: FunctionRoot,
  patterns: readonly TerminalPattern[],
  lookups: HelperLookups,
): boolean {
  return patterns.some(
    (pattern) =>
      (pattern.match.type === "functionCall" &&
        tryMatchFunctionCall(
          call,
          pattern,
          pattern.match,
          lookups.resolution,
          lookups.originatesFrom,
        ) !== null) ||
      (pattern.match.type === "parameterMethodCall" &&
        tryMatchParameterMethodCall(call, func, pattern, pattern.match).length >
          0),
  );
}
