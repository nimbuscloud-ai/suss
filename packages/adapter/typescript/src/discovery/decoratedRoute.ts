// decoratedRoute.ts: discover NestJS-style decorator-driven REST
// controllers (`@Controller("path")` class with `@Get` / `@Post` /
// `@Put` / `@Patch` / `@Delete` methods). Emits units with `routeInfo`
// that the adapter turns into a REST binding directly.

import { type ClassDeclaration, Node, type SourceFile } from "ts-morph";

import { force, literalOf } from "@suss/values";

import { evaluatedValue } from "../values/evaluator.js";
import {
  decoratedCallablesOf,
  importedDecoratorLocals,
} from "./decoratedMembers.js";
import { classDecoratorStandingFor } from "./decoratorComposition.js";
import {
  globalPrefixKey,
  globalPrefixOf,
  pathUnderGlobalPrefix,
} from "./globalPrefix.js";
import {
  libraryExportPathsOf,
  numberValueOf,
  objectLiteralOf,
  propertyOf,
  stringValueOf,
} from "./resolveValue.js";
import { routeVersionSegments, routeVersionsIn } from "./routeVersioning.js";

import type {
  ChannelSource,
  DeclaredBinding,
  DeclaredStatusDecorators,
  DiscoveryPattern,
} from "@suss/extractor";
import type { Decorator, MethodDeclaration } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";
import type { MountPrefixIndex } from "./registrationCall.js";
import type { DiscoveredUnit } from "./shared.js";

/** The path `@Get("subpath")` states, read the way a controller's prefix is. */
function resolveRoutePathArg(
  decorator: Node,
  resolution: ResolutionStore | undefined,
): string | null {
  if (!Node.isDecorator(decorator)) {
    return "";
  }
  return routePathOf(decorator.getArguments(), resolution);
}

/**
 * The path a decorator's argument list states. No argument mounts at
 * the root, and so does an options object with no `path`, such as
 * `@Controller({ host })`. `@Controller({ path, version })` states it
 * in the object. A constant passed by name resolves to its written
 * string (#123).
 *
 * Null when a path is given and does not settle to one string, such as
 * a constant from a package that is not installed. The route then
 * claims no path, since at the root it would pair with the wrong client.
 */
function routePathOf(
  args: Node[],
  resolution: ResolutionStore | undefined,
): string | null {
  const [first] = args;
  if (first === undefined) {
    return "";
  }
  const value = evaluatedValue(first, resolution);
  if (value.kind !== "record") {
    return literalOf(value);
  }
  const path = value.fields.get("path");
  if (path === undefined) {
    return value.open ? null : "";
  }
  return literalOf(force(path.value));
}

const PREFIX_NOT_READ =
  "The path this controller or route declares does not settle to one string, so no path is claimed and this route pairs with nothing";

const VERSION_NOT_READ =
  "This route serves an API version, and the run cannot read the version or how the application serves versions, so no path is claimed and this route pairs with nothing";

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

/**
 * The channel a declared binding's source reads off the handler's own
 * decorator. A constant passed by name resolves to its written string,
 * the same hop a route path gets, and a value the run cannot settle
 * leaves the channel null rather than spelling something wrong.
 */
function declaredChannelOf(
  source: ChannelSource,
  decorator: Node,
  resolution: ResolutionStore | undefined,
): string | null {
  if (source.from === "literal") {
    return source.value;
  }
  if (source.from === "unstated") {
    return null;
  }
  if (!Node.isDecorator(decorator)) {
    return null;
  }
  const arg = decorator.getArguments()[source.position];
  if (arg === undefined) {
    return null;
  }
  const text = stringValueOf(arg, resolution);
  return text === null || text === "" ? null : text;
}

/**
 * The status a decorator such as `@HttpCode(204)` sets on the member
 * the route decorator is on. `HttpStatus.NO_CONTENT` and a named
 * constant resolve through the evaluator the way a path does.
 */
function statusCodeDecoratedOn(
  routeDecorator: Node,
  statusDecorators: readonly string[],
  constants: LibraryConstants,
  resolution: ResolutionStore | undefined,
): number | undefined {
  const member = routeDecorator.getParent();
  if (
    member === undefined ||
    !(Node.isMethodDeclaration(member) || Node.isPropertyDeclaration(member))
  ) {
    return undefined;
  }
  for (const name of statusDecorators) {
    const argument = member.getDecorator(name)?.getArguments()[0];
    if (argument === undefined) {
      continue;
    }
    return (
      numberValueOf(argument, resolution) ??
      libraryConstantOf(argument, constants, resolution) ??
      undefined
    );
  }
  return undefined;
}

/** The constants a library exports, by export path, and the modules that export them. */
interface LibraryConstants {
  modules: string[];
  values: Readonly<Record<string, number>>;
}

/**
 * The number a library constant is equal to, when the value is one of the
 * library's exports the pack lists.
 */
function libraryConstantOf(
  value: Node,
  constants: LibraryConstants,
  resolution: ResolutionStore | undefined,
): number | null {
  for (const path of libraryExportPathsOf(
    value,
    constants.modules,
    resolution,
  )) {
    const found = constants.values[path];
    if (found !== undefined) {
      return found;
    }
  }
  return null;
}

/** What every route in one file needs to read the statuses its decorators declare. */
interface DeclaredStatuses {
  declared: DeclaredStatusDecorators;
  /** The decorators this file imports, by local name, to the name the pack lists. */
  locals: ReadonlyMap<string, string>;
  constants: LibraryConstants;
  resolution: ResolutionStore | undefined;
}

function declaredStatusesIn(
  sourceFile: SourceFile,
  declared: DeclaredStatusDecorators,
  constants: LibraryConstants,
  resolution: ResolutionStore | undefined,
): DeclaredStatuses {
  const locals = importedDecoratorLocals(
    sourceFile,
    [declared.importModule].flat(),
    Object.keys(declared.decorators),
  );
  return { declared, locals, constants, resolution };
}

/**
 * The statuses a route's decorators list, on its method and on its
 * class. A status that does not settle to a number is left out.
 */
function routeDeclaredStatuses(
  statuses: DeclaredStatuses,
  cls: ClassDeclaration,
  routeDecorator: Node,
): number[] {
  if (statuses.locals.size === 0) {
    return [];
  }
  const member = routeDecorator.getParent();
  const own =
    member !== undefined && Node.isMethodDeclaration(member)
      ? statusesDecoratedOn(member, statuses)
      : [];
  return [...new Set([...statusesDecoratedOn(cls, statuses), ...own])].sort(
    (a, b) => a - b,
  );
}

function statusesDecoratedOn(
  decorated: ClassDeclaration | MethodDeclaration,
  { declared, locals, constants, resolution }: DeclaredStatuses,
): number[] {
  const found: number[] = [];
  for (const decorator of decorated.getDecorators()) {
    const name = locals.get(decorator.getName());
    if (name === undefined) {
      continue;
    }
    const status =
      declared.decorators[name] ??
      statusInOptions(decorator, declared.statusKey, constants, resolution);
    if (status !== null && status !== undefined) {
      found.push(status);
    }
  }
  return found;
}

function statusInOptions(
  decorator: Decorator,
  statusKey: string,
  constants: LibraryConstants,
  resolution: ResolutionStore | undefined,
): number | null {
  const [options] = decorator.getArguments();
  const object =
    options === undefined ? null : objectLiteralOf(options, resolution);
  const status =
    object === null ? null : propertyOf(object, statusKey, resolution);
  if (status === null) {
    return null;
  }
  return (
    numberValueOf(status, resolution) ??
    libraryConstantOf(status, constants, resolution)
  );
}

export function discoverDecoratedRoutes(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "decoratedRoute" }>,
  kind: string,
  resolution?: ResolutionStore,
  binding?: DeclaredBinding,
  mountPrefixes?: MountPrefixIndex,
): DiscoveredUnit[] {
  // Same gate as decoratedMethod: at least one method-route decorator
  // must be imported from the framework module.
  const acceptedModules = Array.isArray(match.importModule)
    ? match.importModule
    : [match.importModule];
  const routeDecoratorNames = Object.keys(match.methodDecoratorRouteMap);
  const localRouteDecorators = importedDecoratorLocals(
    sourceFile,
    acceptedModules,
    routeDecoratorNames,
  );
  if (localRouteDecorators.size === 0) {
    return [];
  }
  const statusDecorators =
    match.statusCodeDecorator === undefined
      ? []
      : [
          ...importedDecoratorLocals(sourceFile, acceptedModules, [
            match.statusCodeDecorator,
          ]).keys(),
        ];
  const globalPrefix =
    match.globalPrefix === undefined
      ? null
      : globalPrefixOf(mountPrefixes, globalPrefixKey(match.globalPrefix));
  const versions =
    match.versioning === undefined
      ? null
      : routeVersionsIn(
          sourceFile,
          match.versioning,
          acceptedModules,
          resolution,
          mountPrefixes,
        );
  const declaredStatuses =
    match.declaredStatuses === undefined
      ? null
      : declaredStatusesIn(
          sourceFile,
          match.declaredStatuses,
          {
            modules: acceptedModules,
            values: match.statusCodeConstants ?? {},
          },
          resolution,
        );

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
    const pathPrefix = routePathOf(marker.args, resolution);

    const className = cls.getName() ?? "<anon-class>";
    for (const handler of decoratedCallablesOf(cls, [
      ...localRouteDecorators.keys(),
    ])) {
      if (binding !== undefined) {
        // The pattern states the boundary outright, so the decorator
        // that selected the handler gives the channel rather than a
        // route path.
        results.push({
          func: handler.func,
          kind,
          name: `${className}.${handler.name}`,
          channelInfo: {
            messageBus: binding.messageBus,
            channel: declaredChannelOf(
              binding.channel,
              handler.decorator,
              resolution,
            ),
          },
        });
        continue;
      }

      const verbDecorator =
        localRouteDecorators.get(handler.standsFor) ?? handler.standsFor;
      const httpMethod = match.methodDecoratorRouteMap[verbDecorator];
      const pathSuffix = resolveRoutePathArg(handler.decorator, resolution);
      const status =
        statusCodeDecoratedOn(
          handler.decorator,
          statusDecorators,
          { modules: acceptedModules, values: match.statusCodeConstants ?? {} },
          resolution,
        ) ?? match.defaultStatusCodes?.[verbDecorator];
      const declared =
        declaredStatuses === null
          ? []
          : routeDeclaredStatuses(
              declaredStatuses,
              cls as ClassDeclaration,
              handler.decorator,
            );
      const unit = {
        func: handler.func,
        kind,
        name: `${className}.${handler.name}`,
        ...(status === undefined ? {} : { defaultStatusCode: status }),
        ...(declared.length === 0 ? {} : { declaredStatuses: declared }),
      };

      if (pathPrefix === null || pathSuffix === null) {
        results.push({
          ...unit,
          routeInfo: { method: httpMethod, path: null },
          unreadBinding: PREFIX_NOT_READ,
        });
        continue;
      }

      const path = joinRoutePath(pathPrefix, pathSuffix);
      const segments =
        versions === null
          ? [null]
          : routeVersionSegments(versions, marker.args, handler.decorator);
      if (segments === null) {
        results.push({
          ...unit,
          routeInfo: { method: httpMethod, path: null },
          unreadBinding: VERSION_NOT_READ,
        });
        continue;
      }

      for (const segment of segments) {
        const routePath = pathUnderGlobalPrefix(
          globalPrefix,
          httpMethod,
          joinRoutePath(segment ?? "", path),
        );
        results.push({
          ...unit,
          routeInfo: { method: httpMethod, path: routePath },
        });
      }
    }
  }
  return results;
}
