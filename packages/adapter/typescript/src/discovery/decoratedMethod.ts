// decoratedMethod.ts — discover NestJS-style decorator-driven
// resolvers / handlers (`@Resolver()` class with `@Query` / `@Mutation`
// / `@ResolveField` / `@Subscription` methods).

import { type ClassDeclaration, Node, type SourceFile } from "ts-morph";

import { decoratedCallablesOf } from "./decoratedMembers.js";
import { classDecoratorStandingFor } from "./decoratorComposition.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

/**
 * The type whose field this method answers, or the empty string when
 * the source does not say.
 *
 * A class decorator naming a type answers for every method under it.
 * Without one, the answer is the pack's own: a decorator that puts its
 * field on a root operation type is in the pack's map, and one that
 * needs the class to name a type is not. The second kind, on a class
 * that names none, has nowhere left to read the type from, and the
 * empty string carries that through to a binding nothing pairs with.
 */
function resolverTypeName(args: {
  classTypeName: string | null;
  decoratorName: string;
  typeMap: Record<string, string>;
}): string {
  return args.classTypeName ?? args.typeMap[args.decoratorName] ?? "";
}

/**
 * The first argument to `@Resolver(() => Foo)` is an arrow function
 * returning a class identifier. Walk the AST to recover the class
 * name. Returns null for shapes the adapter doesn't know how to
 * resolve (`@Resolver(() => "Foo")`, `@Resolver(forwardRef(() => Foo))`,
 * etc.) — the caller falls back to a decorator-driven default.
 */
function resolveResolverClassTypeName(decoratorArg: Node): string | null {
  if (Node.isArrowFunction(decoratorArg)) {
    const body = decoratorArg.getBody();
    if (Node.isIdentifier(body)) {
      return body.getText();
    }
    return null;
  }
  if (Node.isStringLiteral(decoratorArg)) {
    return decoratorArg.getLiteralValue();
  }
  if (Node.isIdentifier(decoratorArg)) {
    return decoratorArg.getText();
  }
  return null;
}

/**
 * Read the `name` option from a method decorator's options-object arg
 * (`@Query(() => User, { name: "foo" })`). Returns null when no override
 * is present so the caller can fall back to the method's declared name.
 */
function resolveOperationNameOverride(decorator: Node): string | null {
  if (!Node.isDecorator(decorator)) {
    return null;
  }
  const args = decorator.getArguments();
  for (const arg of args) {
    if (!Node.isObjectLiteralExpression(arg)) {
      continue;
    }
    const prop = arg.getProperty("name");
    if (prop === undefined || !Node.isPropertyAssignment(prop)) {
      continue;
    }
    const init = prop.getInitializer();
    if (init === undefined) {
      continue;
    }
    if (
      Node.isStringLiteral(init) ||
      Node.isNoSubstitutionTemplateLiteral(init)
    ) {
      return init.getLiteralValue();
    }
  }
  return null;
}

export function discoverDecoratedMethods(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "decoratedMethod" }>,
  kind: string,
  resolution?: ResolutionStore,
): DiscoveredUnit[] {
  // Gate on at least one method decorator (e.g. `@Query`, `@Mutation`)
  // being imported from one of the pack-declared modules — that's the
  // signal that this file is operating in the target framework's
  // semantics.
  // Method decorators stay strict to avoid false positives — without
  // an import from the framework module, this file isn't a target.
  const acceptedModules = Array.isArray(match.importModule)
    ? match.importModule
    : [match.importModule];
  const methodDecoratorsFromFramework = new Set<string>();
  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (!acceptedModules.includes(importDecl.getModuleSpecifierValue())) {
      continue;
    }
    for (const named of importDecl.getNamedImports()) {
      const local = named.getAliasNode()?.getText() ?? named.getName();
      if (match.methodDecorators.includes(local)) {
        methodDecoratorsFromFramework.add(local);
      }
    }
  }
  if (methodDecoratorsFromFramework.size === 0) {
    return [];
  }

  const results: DiscoveredUnit[] = [];
  for (const cls of sourceFile.getClasses()) {
    const marker = classDecoratorStandingFor(
      cls as ClassDeclaration,
      match.classDecorators,
      acceptedModules,
      resolution,
    );
    if (marker === null) {
      continue;
    }
    const classTypeName =
      marker.args.length > 0
        ? resolveResolverClassTypeName(marker.args[0] as Node)
        : null;

    const className = cls.getName() ?? "<anon-class>";
    for (const handler of decoratedCallablesOf(cls, match.methodDecorators)) {
      const fieldName =
        resolveOperationNameOverride(handler.decorator) ?? handler.name;
      const typeName = resolverTypeName({
        classTypeName,
        decoratorName: handler.standsFor,
        typeMap: match.methodDecoratorTypeMap,
      });

      results.push({
        func: handler.func,
        kind,
        // `<ClassName>.<memberName>` keeps the summary identity
        // unique within the file and meaningful when read out of
        // context. Same shape as React sub-units (`Comp.handler`).
        name: `${className}.${handler.name}`,
        resolverInfo: { typeName, fieldName },
      });
    }
  }
  return results;
}
