// decoratedMembers.ts: the decorated callables a class declares.
//
// A NestJS handler is usually a method. A class that wants `this` bound
// without writing a constructor writes the same handler as a property
// set to an arrow, and the framework calls it the same way. Reading
// only the methods loses the second spelling, so both discovery
// handlers ask this instead.

import { Node } from "ts-morph";

import { toFunctionRoot } from "./shared.js";

import type {
  ClassDeclaration,
  Decorator,
  MethodDeclaration,
  PropertyDeclaration,
} from "ts-morph";
import type { FunctionRoot } from "../conditions.js";

/** A class member with one of the decorators asked about. */
export interface DecoratedCallable {
  /**
   * The function the member is: the method itself, or the arrow a
   * property is set to. Everything downstream reads a body and
   * parameters off this, and both spellings give the same ones.
   */
  func: FunctionRoot;
  name: string;
  /** Which of the names asked about this member carries. */
  standsFor: string;
  decorator: Decorator;
}

/**
 * The members of `cls` decorated with one of `decoratorNames`, in
 * source order. The first name on a member wins, which is what a class
 * that spells two route verbs on one member means anyway.
 */
export function decoratedCallablesOf(
  cls: ClassDeclaration,
  decoratorNames: string[],
): DecoratedCallable[] {
  const callables: DecoratedCallable[] = [];
  for (const member of cls.getMembers()) {
    if (
      !Node.isMethodDeclaration(member) &&
      !Node.isPropertyDeclaration(member)
    ) {
      continue;
    }
    const func = callableOf(member);
    if (func === null) {
      continue;
    }
    for (const candidate of decoratorNames) {
      const decorator = member.getDecorator(candidate);
      if (decorator === undefined) {
        continue;
      }
      callables.push({
        func,
        name: member.getName(),
        standsFor: candidate,
        decorator,
      });
      break;
    }
  }
  return callables;
}

/**
 * The function a class member is, or null when the member is set to
 * something other than a function. A property initialised with a
 * config object is not a handler however it is decorated.
 */
function callableOf(
  member: MethodDeclaration | PropertyDeclaration,
): FunctionRoot | null {
  if (Node.isMethodDeclaration(member)) {
    return toFunctionRoot(member);
  }
  const held = member.getInitializer();
  return held === undefined ? null : toFunctionRoot(held);
}
