/**
 * Syntactic reads of a unit's parameters, for `inputReads`.
 *
 * The derived reads come out of conditions and output values, so a
 * read that only appears in a render tree or a template never makes
 * it: a component reading `props.title` only in its JSX never
 * reported the read. This walk finds every reference to a parameter binding in
 * the body, symbol-matched so a shadowing inner binding is never
 * mistaken for the parameter, and records the property chain walked
 * from it. The extractor merges these with the derived reads.
 */

import { Node } from "ts-morph";

import { symbolBehind } from "./resolve/functionBehind.js";
import { type DescentBarriers, NO_BARRIERS } from "./walk/descent.js";

import type { InputRead } from "@suss/extractor";
import type { Identifier } from "ts-morph";
import type { FunctionRoot } from "./conditions.js";

/** The chain above a reference: `props.user.name` gives [user, name]. */
function pathAbove(reference: Identifier): string[] {
  const path: string[] = [];
  let current: Node = reference;
  for (;;) {
    const parent = current.getParent();
    if (
      parent !== undefined &&
      Node.isPropertyAccessExpression(parent) &&
      parent.getExpression() === current
    ) {
      path.push(parent.getName());
      current = parent;
      continue;
    }
    if (
      parent !== undefined &&
      Node.isElementAccessExpression(parent) &&
      parent.getExpression() === current
    ) {
      const argument = parent.getArgumentExpression();
      if (argument !== undefined && Node.isStringLiteral(argument)) {
        path.push(argument.getLiteralValue());
        current = parent;
        continue;
      }
    }
    return path;
  }
}

function declaresParameterOf(node: Node, func: FunctionRoot): boolean {
  if (Node.isParameterDeclaration(node)) {
    return node.getParent() === func;
  }
  if (Node.isBindingElement(node)) {
    const parameter = node.getFirstAncestor(Node.isParameterDeclaration);
    return parameter !== undefined && parameter.getParent() === func;
  }
  return false;
}

export function parameterReads(
  func: FunctionRoot,
  parameterNames: ReadonlyArray<string>,
  barriers: DescentBarriers = NO_BARRIERS,
): InputRead[] {
  return readsOfParameters(func, func, parameterNames, barriers);
}

/**
 * The reads a pack-claimed sub-unit, such as a component's click handler,
 * makes of the parameters of the unit it is declared in. They go on the
 * sub-unit's own summary, since the parent's walk stops at the sub-unit.
 */
export function enclosingParameterReads(
  subUnit: FunctionRoot,
  enclosing: FunctionRoot,
  parameterNames: ReadonlyArray<string>,
  barriers: DescentBarriers = NO_BARRIERS,
): InputRead[] {
  return readsOfParameters(subUnit, enclosing, parameterNames, barriers);
}

function readsOfParameters(
  walked: FunctionRoot,
  owner: FunctionRoot,
  parameterNames: ReadonlyArray<string>,
  barriers: DescentBarriers,
): InputRead[] {
  const wanted = new Set(parameterNames);
  if (wanted.size === 0) {
    return [];
  }

  const found = new Map<string, InputRead>();
  walked.forEachDescendant((node, traversal) => {
    // A pack-claimed sub-unit reads on its own summary, so a
    // parameter it captures never counts as the parent's read.
    if (barriers.has(node)) {
      traversal.skip();
      return;
    }
    if (!Node.isIdentifier(node) || !wanted.has(node.getText())) {
      return;
    }
    const declarations = symbolBehind(node)?.getDeclarations() ?? [];
    if (!declarations.some((decl) => declaresParameterOf(decl, owner))) {
      return;
    }
    // The declaration site itself is not a read.
    const inDeclaration = declarations.some(
      (decl) =>
        decl.getStart() <= node.getStart() && node.getEnd() <= decl.getEnd(),
    );
    if (inDeclaration) {
      return;
    }

    const read = { input: node.getText(), path: pathAbove(node) };
    const key = `${read.input}\u0000${read.path.join(".")}`;
    if (!found.has(key)) {
      found.set(key, read);
    }
  });

  return [...found.values()];
}
