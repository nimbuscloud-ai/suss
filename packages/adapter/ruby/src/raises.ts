/**
 * The raises written in a method body that leave the method, and the
 * class each one raises. A raise inside a `begin` or a method body with a
 * `rescue` clause is caught there and goes on in the clause, which the
 * path engine already walks, so it is left out.
 */

import { children, field, OWN_BODY_TYPES, readCallArgs } from "./ast.js";
import { MESSAGE_ONLY_EXCEPTION } from "./exceptionClasses.js";
import { isRaise } from "./paths/lowering.js";
import { constantRefCandidates } from "./scope.js";

import type { RbNode } from "./parser.js";
import type { ConstantRef } from "./scope.js";

/** Bodies whose `rescue` clauses catch what the statements before them raise. */
const RESCUING_BODIES = new Set(["begin", "body_statement"]);

/** The parts of a rescuing body that run after a raise is caught, where a raise is not caught again. */
const AFTER_CATCH = new Set(["rescue", "else", "ensure"]);

/** Every raise in the method's body that no rescue in the method catches, in source order. */
export function escapingRaises(method: RbNode): RbNode[] {
  const body = field(method, "body");
  if (body === null) {
    return [];
  }
  const found: RbNode[] = [];
  const visit = (node: RbNode): void => {
    for (const child of children(node)) {
      if (child === null || OWN_BODY_TYPES.has(child.type)) {
        continue;
      }
      if (isRaise(child) && !caughtLocally(child, method)) {
        found.push(child);
        continue;
      }
      visit(child);
    }
  };
  visit(body);
  return found;
}

/** Whether a rescue between the raise and the method catches it. */
function caughtLocally(raise: RbNode, method: RbNode): boolean {
  let child = raise;
  for (
    let parent = raise.parent;
    parent !== null && parent.id !== method.id;
    parent = parent.parent
  ) {
    if (rescues(parent, child)) {
      return true;
    }
    child = parent;
  }
  return false;
}

function rescues(parent: RbNode, child: RbNode): boolean {
  if (parent.type === "rescue_modifier") {
    return field(parent, "body")?.id === child.id;
  }
  return (
    RESCUING_BODIES.has(parent.type) &&
    !AFTER_CATCH.has(child.type) &&
    children(parent).some((one) => one?.type === "rescue")
  );
}

/**
 * The class a raise raises: `raise NotAllowed`, `raise NotAllowed, "why"`
 * or `raise NotAllowed.new("why")`. A message alone raises RuntimeError.
 * Null for an exception the source computes, such as a local variable.
 */
export function raisedClassRef(
  call: RbNode,
  nesting: readonly string[],
): ConstantRef | null {
  const first = readCallArgs(field(call, "arguments")).positional[0];
  if (first === undefined) {
    return null;
  }
  if (first.type === "string") {
    return {
      text: MESSAGE_ONLY_EXCEPTION,
      candidates: [MESSAGE_ONLY_EXCEPTION],
    };
  }
  const constant = constructedClass(first) ?? first;
  const candidates = constantRefCandidates(constant, nesting);
  return candidates.length === 0 ? null : { text: constant.text, candidates };
}

/** The class in `NotAllowed.new(...)`, or null for any other expression. */
function constructedClass(node: RbNode): RbNode | null {
  if (node.type !== "call" || field(node, "method")?.text !== "new") {
    return null;
  }
  return field(node, "receiver");
}
