// decoratedMethod.ts — discover NestJS-style decorator-driven
// resolvers / handlers (`@Resolver()` class with `@Query` / `@Mutation`
// / `@ResolveField` / `@Subscription` methods).

import { type MethodDeclaration, Node, type SourceFile } from "ts-morph";

import type { DiscoveryPattern } from "@suss/extractor";
import type { DiscoveredUnit } from "./shared.js";

/**
 * Map a method-decorator name to the `graphql-resolver` typeName that
 * should be used when the class decorator carries no explicit type
 * argument. NestJS allows `@Resolver()` (no arg) on classes that only
 * declare top-level operations; the operation kind picks the type.
 */
function defaultTypeNameForDecorator(decoratorName: string): string {
  if (decoratorName === "Mutation") {
    return "Mutation";
  }
  if (decoratorName === "Subscription") {
    return "Subscription";
  }
  // ResolveField on a class without `@Resolver(() => Foo)` is an
  // error in real NestJS. We surface it as "Query" with the field
  // name preserved — the pairing layer will record a no-match.
  return "Query";
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
): DiscoveredUnit[] {
  // Gate on at least one method decorator (e.g. `@Query`, `@Mutation`)
  // being imported from one of the pack-declared modules — that's the
  // signal that this file is operating in the target framework's
  // semantics. Class decorators are matched by name only: codebases
  // commonly wrap the framework's class decorator in their own
  // factory (NestJS apps frequently declare `MetadataResolver` /
  // `CoreResolver` that re-emit `@Resolver()`), and those wrappers
  // are imported from project-internal paths the pack can't enumerate.
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
    let classDecorator: ReturnType<typeof cls.getDecorator> | undefined;
    for (const candidate of match.classDecorators) {
      classDecorator = cls.getDecorator(candidate);
      if (classDecorator !== undefined) {
        break;
      }
    }
    if (classDecorator === undefined) {
      continue;
    }
    const classArgs = classDecorator.getArguments();
    const classTypeName =
      classArgs.length > 0 ? resolveResolverClassTypeName(classArgs[0]) : null;

    const className = cls.getName() ?? "<anon-class>";
    for (const method of cls.getMethods()) {
      let matchedDecoratorName: string | null = null;
      let matchedDecorator: Node | null = null;
      for (const candidate of match.methodDecorators) {
        const decorator = method.getDecorator(candidate);
        if (decorator !== undefined) {
          matchedDecoratorName = candidate;
          matchedDecorator = decorator;
          break;
        }
      }
      if (matchedDecoratorName === null || matchedDecorator === null) {
        continue;
      }

      const methodName = method.getName();
      const fieldName =
        resolveOperationNameOverride(matchedDecorator) ?? methodName;
      const typeName =
        classTypeName ?? defaultTypeNameForDecorator(matchedDecoratorName);

      results.push({
        func: method as MethodDeclaration,
        kind,
        // `<ClassName>.<methodName>` keeps the summary identity
        // unique within the file and meaningful when read out of
        // context. Same shape as React sub-units (`Comp.handler`).
        name: `${className}.${methodName}`,
        resolverInfo: { typeName, fieldName },
      });
    }
  }
  return results;
}
