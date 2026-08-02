// decoratorComposition.ts — find the framework decorator a class
// carries, including when the class carries a project decorator built
// out of it.
//
// A codebase that wants every resolver to also set some metadata writes
// its own decorator that calls the framework's, and applies that one
// instead. The class is still a resolver, and nothing about it says so
// by name. The fact layer answers what the project decorator ends up
// calling, so a wrapper is recognized by what it does rather than by
// what it is called.

import { Node } from "ts-morph";

import type { ClassDeclaration, Decorator } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

/**
 * The decorator on `cls` that stands for one of `names`, and which of
 * them it stands for. A decorator with one of those names stands for
 * itself; anything else has to reach one of them by calling into
 * `modules`.
 *
 * Answers null when the class carries no such decorator.
 */
export function classDecoratorStandingFor(
  cls: ClassDeclaration,
  names: string[],
  modules: string[],
  resolution: ResolutionStore | undefined,
): { decorator: Decorator; standsFor: string } | null {
  // The framework's own name first, so a class that spells it out never
  // pays for a resolution query.
  for (const candidate of names) {
    const decorator = cls.getDecorator(candidate);
    if (decorator !== undefined) {
      return { decorator, standsFor: candidate };
    }
  }

  if (resolution === undefined) {
    return null;
  }

  for (const decorator of cls.getDecorators()) {
    const callee = calleeOf(decorator);
    if (!isDeclaredInProject(callee)) {
      continue;
    }
    const applied = resolution.importedCallsOf(callee, modules);
    const standsFor = names.find((name) => applied.includes(name));
    if (standsFor !== undefined) {
      return { decorator, standsFor };
    }
  }
  return null;
}

/**
 * Whether the project itself declares what this expression names. A
 * decorator a library declares has no body here to read, and asking
 * about it pulls that library's import closure into the program for an
 * answer that is always empty.
 */
function isDeclaredInProject(callee: Node): boolean {
  let root: Node = callee;
  while (Node.isPropertyAccessExpression(root)) {
    root = root.getExpression();
  }
  if (!Node.isIdentifier(root)) {
    return false;
  }
  const local = root.getSymbol();
  if (local === undefined) {
    return false;
  }
  // An import specifier is itself a declaration in this file, so the
  // question is about what it points at.
  const symbol = local.getAliasedSymbol() ?? local;
  return symbol
    .getDeclarations()
    .some(
      (declaration) =>
        !declaration.getSourceFile().getFilePath().includes("/node_modules/"),
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
