// decoratedRoute.ts — discover NestJS-style decorator-driven REST
// controllers (`@Controller("path")` class with `@Get` / `@Post` /
// `@Put` / `@Patch` / `@Delete` methods). Emits units with `routeInfo`
// that the adapter turns into a REST binding directly.

import { type MethodDeclaration, Node, type SourceFile } from "ts-morph";

import type { DiscoveryPattern } from "@suss/extractor";
import type { DiscoveredUnit } from "./shared.js";

/**
 * Read the first argument of `@Controller("path")` / `@Get("subpath")`
 * as a path string. Empty arg list yields the empty string (NestJS
 * behaviour: `@Controller()` mounts at root). Non-string args (a
 * route options object, a path-array, etc.) yield the empty string
 * too — the caller falls back to whatever it can extract elsewhere.
 */
function resolveRoutePathArg(decorator: Node): string {
  if (!Node.isDecorator(decorator)) {
    return "";
  }
  const args = decorator.getArguments();
  if (args.length === 0) {
    return "";
  }
  const first = args[0];
  if (
    Node.isStringLiteral(first) ||
    Node.isNoSubstitutionTemplateLiteral(first)
  ) {
    return first.getLiteralValue();
  }
  return "";
}

/**
 * Join a controller's class-prefix with a method-suffix. NestJS
 * normalises a single leading slash and treats empty segments as
 * "skip"; mirror that. The result always starts with exactly one
 * slash so REST pairing keys collide cleanly with other packs'
 * `(METHOD, /path)` shape.
 */
function joinRoutePath(prefix: string, suffix: string): string {
  const segments: string[] = [];
  for (const part of [prefix, suffix]) {
    const trimmed = part.replace(/^\/+|\/+$/g, "");
    if (trimmed.length > 0) {
      segments.push(trimmed);
    }
  }
  return `/${segments.join("/")}`;
}

export function discoverDecoratedRoutes(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "decoratedRoute" }>,
  kind: string,
): DiscoveredUnit[] {
  // Same gate as decoratedMethod: at least one method-route decorator
  // must be imported from the framework module. Class decorators
  // match by name only (project wrappers welcome).
  const acceptedModules = Array.isArray(match.importModule)
    ? match.importModule
    : [match.importModule];
  const routeDecoratorNames = Object.keys(match.methodDecoratorRouteMap);
  const importedRouteDecorators = new Set<string>();
  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (!acceptedModules.includes(importDecl.getModuleSpecifierValue())) {
      continue;
    }
    for (const named of importDecl.getNamedImports()) {
      const local = named.getAliasNode()?.getText() ?? named.getName();
      if (routeDecoratorNames.includes(local)) {
        importedRouteDecorators.add(local);
      }
    }
  }
  if (importedRouteDecorators.size === 0) {
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
    const pathPrefix = resolveRoutePathArg(classDecorator);

    const className = cls.getName() ?? "<anon-class>";
    for (const method of cls.getMethods()) {
      let matchedDecoratorName: string | null = null;
      let matchedDecorator: Node | null = null;
      for (const candidate of routeDecoratorNames) {
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

      const httpMethod = match.methodDecoratorRouteMap[matchedDecoratorName];
      const pathSuffix = resolveRoutePathArg(matchedDecorator);
      const routePath = joinRoutePath(pathPrefix, pathSuffix);

      const methodName = method.getName();
      results.push({
        func: method as MethodDeclaration,
        kind,
        name: `${className}.${methodName}`,
        routeInfo: { method: httpMethod, path: routePath },
      });
    }
  }
  return results;
}
