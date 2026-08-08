// decoratedRoute.ts: discover NestJS-style decorator-driven REST
// controllers (`@Controller("path")` class with `@Get` / `@Post` /
// `@Put` / `@Patch` / `@Delete` methods). Emits units with `routeInfo`
// that the adapter turns into a REST binding directly.

import { type ClassDeclaration, Node, type SourceFile } from "ts-morph";

import { decoratedCallablesOf } from "./decoratedMembers.js";
import { classDecoratorStandingFor } from "./decoratorComposition.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

/**
 * Read the first argument of `@Controller("path")` / `@Get("subpath")`
 * as a path string. Empty arg list yields the empty string (NestJS
 * behaviour: `@Controller()` mounts at root). Non-string args (a
 * route options object, a path-array, etc.) yield the empty string
 * too: the caller falls back to whatever it can extract elsewhere.
 */
function resolveRoutePathArg(decorator: Node): string {
  if (!Node.isDecorator(decorator)) {
    return "";
  }
  return routePathOf(decorator.getArguments());
}

/** The path a decorator's argument list states, when it states one. */
function routePathOf(args: Node[]): string {
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
  resolution?: ResolutionStore,
): DiscoveredUnit[] {
  // Same gate as decoratedMethod: at least one method-route decorator
  // must be imported from the framework module.
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
    const marker = classDecoratorStandingFor(
      cls as ClassDeclaration,
      match.classDecorators,
      acceptedModules,
      resolution,
    );
    if (marker === null) {
      continue;
    }
    const pathPrefix = routePathOf(marker.args);

    const className = cls.getName() ?? "<anon-class>";
    for (const handler of decoratedCallablesOf(cls, routeDecoratorNames)) {
      const httpMethod = match.methodDecoratorRouteMap[handler.standsFor];
      const pathSuffix = resolveRoutePathArg(handler.decorator);
      const routePath = joinRoutePath(pathPrefix, pathSuffix);

      results.push({
        func: handler.func,
        kind,
        name: `${className}.${handler.name}`,
        routeInfo: { method: httpMethod, path: routePath },
      });
    }
  }
  return results;
}
