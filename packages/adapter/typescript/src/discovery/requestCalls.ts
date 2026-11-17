/**
 * requestCalls.ts: the client units a pack's request hooks find in one
 * file. A call a hook claims makes the function it is written in a client
 * of that request. Discovery keeps one client unit per function, the first
 * it finds, so units come in the order the pack's table lists its methods,
 * then in the order the file writes them, as when each verb was a pattern.
 *
 * The ops read a call's name off the node and state its facts only when a
 * hook asks more. What a receiver or a callee was written as is settled
 * once per file for every receiver of one method name, and once for every
 * bare callee, since a question each would run the rules once per call.
 */

import { Node, type SourceFile, SyntaxKind } from "ts-morph";

import { deferredCallOps } from "../resolve/deferredCallOps.js";
import { opsOverFactsIn } from "../resolve/opsOverFacts.js";
import { memberNameOf } from "../walk/propertyName.js";
import { forEachDescendantOfKinds } from "../walk/rawDescent.js";
import { peelValue } from "../walk/unwrap.js";
import { findEnclosingFunction } from "./shared.js";

import type { CallOps, RequestRecognizer } from "@suss/extractor";
import type { CallExpression } from "ts-morph";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";
import type { CallReading } from "../resolve/callOps.js";
import type { DiscoveredUnit } from "./shared.js";

const CALL_KIND: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.CallExpression]);

/** The objects a global is reachable through, in a browser or in Node. */
const RUNTIME_GLOBAL_OBJECTS: ReadonlySet<string> = new Set([
  "globalThis",
  "window",
  "self",
  "global",
]);

/** One request hook a pack gives the walk. */
export interface PackRequestHook {
  readonly hook: RequestRecognizer;
  /**
   * Whether the hook's units go in the order its methods table lists the
   * methods. A pack declared with `httpRequests` says so. A hook read off
   * one `clientCall` pattern gives its units in the order the file writes
   * them, as the pattern did.
   */
  readonly ranked: boolean;
}

/** A unit, and where it goes among the others the pack's hooks found. */
interface Placed {
  readonly rank: number;
  readonly hook: number;
  readonly order: number;
  readonly unit: DiscoveredUnit;
}

/** The client units the hooks find in one file, in the pack's order. */
export function requestUnitsIn(
  sourceFile: SourceFile,
  hooks: readonly PackRequestHook[],
  kind: string,
  resolution: ResolutionStore,
): DiscoveredUnit[] {
  if (hooks.length === 0) {
    return [];
  }
  const placed: Placed[] = [];
  // A method call is looked up by its method before anything else, so a
  // method no table lists needs no ops at all.
  const listed = new Set(hooks.flatMap(({ hook }) => hook.entries));
  const admits = (method: string | null): boolean =>
    method === null || listed.has(method);
  forEachCallIn(sourceFile, resolution, admits, (call, ops, order) => {
    const ctx = { ops };
    hooks.forEach(({ hook, ranked }, index) => {
      const claims = hook(call, ctx) ?? [];
      const func = claims.length === 0 ? null : findEnclosingFunction(call);
      if (func === null) {
        return;
      }
      const methodName = methodNameOf(call);
      for (const request of claims) {
        placed.push({
          rank: ranked ? rankOf(hook, request.read.entry) : 0,
          hook: index,
          order,
          unit: {
            func,
            kind,
            name: clientUnitName(func, methodName),
            callSite: {
              callExpression: call,
              methodName,
              request,
              ...(request.site === undefined ? {} : { under: request.site }),
            },
          },
        });
      }
    });
  });
  return placed
    .sort((a, b) => a.rank - b.rank || a.hook - b.hook || a.order - b.order)
    .map(({ unit }) => unit);
}

/**
 * Every call in the file whose method `admits` takes, null for a call
 * with no receiver, in the order the file writes them, with the ops a
 * hook reads it through. One fact source serves the file, and a call's
 * facts are stated only when a question past its name needs them.
 */
export function forEachCallIn(
  sourceFile: SourceFile,
  resolution: ResolutionStore,
  admits: (method: string | null) => boolean,
  visit: (call: CallExpression, ops: CallOps, order: number) => void,
): void {
  const calls: CallExpression[] = [];
  forEachDescendantOfKinds(sourceFile, CALL_KIND, (node) => {
    calls.push(node as CallExpression);
    return false;
  });
  const reading: CallReading & { readonly resolution: ResolutionStore } = {
    resolve: writtenValuesIn(calls, resolution),
    resolution,
    originatesFrom: (value, module) => resolution.originatesFrom(value, module),
  };
  const overFacts = opsOverFactsIn(reading);
  calls.forEach((call, order) => {
    const callee = peelValue(call.getExpression());
    const method = Node.isPropertyAccessExpression(callee)
      ? callee.getName()
      : null;
    if (admits(method)) {
      visit(
        call,
        deferredCallOps(call, reading, () => overFacts(call)),
        order,
      );
    }
  });
}

/** Where an entry comes in the hook's table, a call of the client itself that no entry shares coming last. */
function rankOf(hook: RequestRecognizer, entry: string | null): number {
  const at = entry === null ? -1 : hook.entries.indexOf(entry);
  return at === -1 ? hook.entries.length : at;
}

/**
 * The method the call reads off the client, or null for a function
 * called as itself. A function read off the runtime's global object,
 * `window.fetch(url)`, is the global function called as itself.
 */
export function methodNameOf(call: CallExpression): string | null {
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee) &&
    !RUNTIME_GLOBAL_OBJECTS.has(callee.getExpression().getText())
    ? callee.getName()
    : null;
}

/**
 * What a name in this file was written as, settled together for every
 * receiver of a method with the same name, and for every callee of a
 * call with no receiver, the first time a hook asks about one of them.
 * Anything else is asked on its own.
 */
function writtenValuesIn(
  calls: readonly CallExpression[],
  store: ResolutionStore,
): (value: Node) => Node | null {
  // Grouped on the first question, since most files are asked none.
  let grouped: CallGroups | null = null;
  const written = new Map<Node, Node | null>();
  return (value) => {
    const known = written.get(value);
    if (known !== undefined) {
      return known;
    }
    grouped ??= callGroupsOf(calls);
    const group = grouped.groupOf.get(value);
    const members = group === undefined ? undefined : grouped.groups.get(group);
    if (group === undefined || members === undefined) {
      return store.resolveWrittenValue(value);
    }
    grouped.groups.delete(group);
    for (const [member, found] of store.resolveWrittenValues(members)) {
      written.set(member, found);
    }
    return written.get(value) ?? null;
  };
}

/** The receivers of each method name, and the callees of calls with no receiver, that one round settles together. */
interface CallGroups {
  readonly groups: Map<string, Node[]>;
  readonly groupOf: Map<Node, string>;
}

function callGroupsOf(calls: readonly CallExpression[]): CallGroups {
  const groups = new Map<string, Node[]>();
  const groupOf = new Map<Node, string>();
  const join = (group: string, value: Node): void => {
    const members = groups.get(group) ?? [];
    members.push(value);
    groups.set(group, members);
    groupOf.set(value, group);
  };
  for (const call of calls) {
    const callee = peelValue(call.getExpression());
    if (Node.isIdentifier(callee)) {
      join("()", callee);
      continue;
    }
    if (!Node.isPropertyAccessExpression(callee)) {
      continue;
    }
    const receiver = peelValue(callee.getExpression());
    if (
      Node.isIdentifier(receiver) ||
      Node.isPropertyAccessExpression(receiver)
    ) {
      join(`.${callee.getName()}`, receiver);
    }
  }
  return { groups, groupOf };
}

/**
 * A stable name for a client unit, from the shape of the function the
 * call is written in: its own name, then the variable or property it is
 * bound to, then the method the call reads off the client. "anonymous"
 * is the last resort.
 */
export function clientUnitName(
  enclosingFunc: FunctionRoot,
  methodName: string | null,
): string {
  if (Node.isFunctionDeclaration(enclosingFunc)) {
    return enclosingFunc.getName() ?? methodName ?? "anonymous";
  }
  if (Node.isMethodDeclaration(enclosingFunc)) {
    return memberNameOf(enclosingFunc);
  }
  const parent = enclosingFunc.getParent();
  if (parent !== undefined && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  if (parent !== undefined && Node.isPropertyAssignment(parent)) {
    return memberNameOf(parent);
  }
  return methodName ?? "anonymous";
}
