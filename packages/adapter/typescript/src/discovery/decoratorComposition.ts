// decoratorComposition.ts: find the framework decorator a class
// carries, including when the class carries a project decorator built
// out of it.
//
// A codebase that wants every resolver to also set some metadata writes
// its own decorator that calls the framework's, and applies that one
// instead. The class is still a resolver, and nothing about it says so
// by name. The same goes for the framework's own decorator imported
// under another name, which a project does when the framework's name
// collides with one of its own.
//
// The fact layer answers which library names a decorator stands for, so
// a wrapper is recognized by what it does rather than by what it is
// called.

import { Node, SyntaxKind } from "ts-morph";

import type { ClassDeclaration, Decorator } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

/**
 * The framework decorator a class carries: which of `names` it stands
 * for, and the arguments that decorator was given.
 *
 * The arguments matter as much as the match. A route prefix and a
 * resolver's type both arrive as the framework decorator's first
 * argument, and a project wrapper can state them in either of two
 * places, so `args` is where they turned out to be rather than a fixed
 * position in the source.
 */
export interface FrameworkDecorator {
  decorator: Decorator;
  standsFor: string;
  args: Node[];
}

/**
 * The decorator on `cls` that stands for one of `names`. A decorator
 * spelled with one of those names stands for itself; anything else has
 * to be one of them under another name, or reach one of them by calling
 * into `modules`.
 *
 * Answers null when the class carries no such decorator.
 */
export function classDecoratorStandingFor(
  cls: ClassDeclaration,
  names: string[],
  modules: string[],
  resolution: ResolutionStore | undefined,
): FrameworkDecorator | null {
  // The framework's own name first, so a class that spells it out never
  // pays for a resolution query. That is the common case by a wide
  // margin, and the query below is what the rest costs.
  for (const candidate of names) {
    const decorator = cls.getDecorator(candidate);
    if (decorator !== undefined) {
      return {
        decorator,
        standsFor: candidate,
        args: decorator.getArguments(),
      };
    }
  }

  if (resolution === undefined) {
    return null;
  }

  for (const decorator of cls.getDecorators()) {
    const applied = resolution.importedNamesOf(calleeOf(decorator), modules);
    const standsFor = names.find((name) => applied.includes(name));
    if (standsFor === undefined) {
      continue;
    }
    return {
      decorator,
      standsFor,
      args: frameworkArgs(decorator, standsFor, modules, resolution),
    };
  }
  return null;
}

/**
 * What the framework's decorator was given, for a class that applied a
 * project wrapper instead.
 *
 * A wrapper states the argument in one of two places. `@Section("/x")`
 * on a wrapper written as `(path) => Controller(path)` states it at the
 * class, and that is what the class means whatever the wrapper does
 * with it. `@Section()` on a wrapper written as `() =>
 * Controller("/x")` states it inside the wrapper, and reading the class
 * alone gives a controller mounted at the root, which is a route that
 * pairs with the wrong thing rather than one that is missing.
 *
 * So the class wins when it says anything, and the wrapper's own call
 * answers when it does not. A wrapper that forwards its own parameter,
 * as `(typeFunc) => Resolver(typeFunc)` does, states nothing either
 * way: whatever the class passed is the answer, and the class passed
 * nothing.
 */
function frameworkArgs(
  decorator: Decorator,
  standsFor: string,
  modules: string[],
  resolution: ResolutionStore,
): Node[] {
  const atClass = decorator.getArguments();
  if (atClass.length > 0) {
    return atClass;
  }
  const wrapper = resolution.resolveCallable(calleeOf(decorator));
  if (wrapper === null) {
    return atClass;
  }
  for (const call of wrapper.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const names = resolution.importedNamesOf(call.getExpression(), modules);
    if (!names.includes(standsFor)) {
      continue;
    }
    const args = call.getArguments();
    return args.every((arg) => statesAValue(arg, wrapper)) ? args : atClass;
  }
  return atClass;
}

/**
 * Whether an argument states a value where it is written, rather than
 * naming something the wrapper was handed.
 */
function statesAValue(arg: Node, wrapper: Node): boolean {
  const identifiers = Node.isIdentifier(arg)
    ? [arg]
    : arg.getDescendantsOfKind(SyntaxKind.Identifier);
  return !identifiers.some((identifier) =>
    identifier
      .getSymbol()
      ?.getDeclarations()
      .some(
        (declaration) =>
          Node.isParameterDeclaration(declaration) &&
          isWithin(declaration, wrapper),
      ),
  );
}

/** Whether one node sits inside another. */
function isWithin(node: Node, container: Node): boolean {
  return (
    node.getSourceFile() === container.getSourceFile() &&
    node.getStart() >= container.getStart() &&
    node.getEnd() <= container.getEnd()
  );
}

/**
 * What a decorator names, whether it is applied bare or called:
 * `@Resolver` and `@Resolver(() => User)` both name `Resolver`, and
 * `@ns.Resolver()` names the property read, since that is the
 * expression the fact layer can follow.
 */
function calleeOf(decorator: Decorator): Node {
  const call = decorator.getCallExpression();
  if (call !== undefined) {
    return call.getExpression();
  }
  return decorator.getExpression();
}
