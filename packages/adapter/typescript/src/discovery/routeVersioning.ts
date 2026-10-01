/**
 * The API versions a decorated route serves, and the paths they put it at.
 *
 * NestJS reads `@Controller({ version })` and `@Version()` only after the
 * bootstrap calls `app.enableVersioning()`, usually in a file with no
 * controller in it. URI versioning puts `v1` in the path after the global
 * prefix and before the controller's path. Header, media type and custom
 * versioning leave the path alone, so every version of a route shares it.
 *
 * When the run cannot read how the application serves versions, a route
 * that states a version claims no path. Any path it claimed could pair it
 * with a client or a document for another version.
 */

import { Node, type SourceFile } from "ts-morph";

import { constantOf, literalOf } from "@suss/values";

import { recordMountPrefix } from "../depTracking.js";
import { evaluatedValue } from "../values/evaluator.js";
import { importedDecoratorLocals } from "./decoratedMembers.js";
import { applicationsMadeIn } from "./globalPrefix.js";
import {
  arrayElementsOf,
  libraryExportPathsOf,
  numberValueOf,
  objectLiteralOf,
  propertyOf,
  stringValueOf,
} from "./resolveValue.js";

import type { RouteVersioning, VersionPlacement } from "@suss/extractor";
import type { ResolutionStore } from "../facts/store.js";
import type { MountPrefixIndex } from "./registrationCall.js";

/** The versions a route or an application states. Null in the list means every version. */
export type StatedVersion =
  | { kind: "unstated" }
  | { kind: "unread" }
  | { kind: "listed"; versions: ReadonlyArray<string | null> };

/**
 * How an application serves versions. `off` means the run read the
 * application and nothing turns versioning on, so Nest ignores every
 * version a route states.
 */
export type AppVersioning =
  | { kind: "off" }
  | { kind: "unread" }
  | {
      kind: "on";
      placement: VersionPlacement;
      pathPrefix: string;
      defaultVersion: StatedVersion;
    };

const UNSTATED: StatedVersion = { kind: "unstated" };
const UNREAD_VERSION: StatedVersion = { kind: "unread" };
const UNREAD_APP: AppVersioning = { kind: "unread" };

const KEY_START = "version:";

/** What a run's recorded assumption about a pattern's versioning is keyed by. */
export function routeVersioningKey(versioning: RouteVersioning): string {
  const { importModule, importName, factory } = versioning.call.application;
  return `${KEY_START}${importModule}:${importName}.${factory}().${versioning.call.method}`;
}

export function isRouteVersioningKey(id: string): boolean {
  return id.startsWith(KEY_START);
}

export function describeVersioning(versioning: AppVersioning | null): string {
  return versioning === null ? "" : JSON.stringify(versioning);
}

/**
 * How the run's applications serve versions for this key, recorded as an
 * assumption of the file being walked, since it comes from another file.
 */
export function versioningOf(
  index: MountPrefixIndex | undefined,
  key: string,
): AppVersioning {
  const versioning = index?.versionings?.get(key) ?? UNREAD_APP;
  recordMountPrefix(key, describeVersioning(versioning));
  return versioning;
}

/** What one file says about how its applications serve versions. */
export interface VersioningInFile {
  applications: number;
  calls: AppVersioning[];
}

/**
 * The applications this file makes and every versioning call in it. A
 * call counts whatever its receiver is. Bootstraps often get the app
 * from a helper or a test module, where the run cannot follow it back
 * to the factory, and the method is the framework's own.
 */
export function versioningIn(
  sourceFile: SourceFile,
  versioning: RouteVersioning,
  modules: string[],
  resolution: ResolutionStore,
): VersioningInFile {
  const applications = applicationsMadeIn(
    sourceFile,
    versioning.call,
    resolution,
  );
  if (!sourceFile.getFullText().includes(versioning.call.method)) {
    return { applications, calls: [] };
  }
  const calls: AppVersioning[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    if (
      !Node.isPropertyAccessExpression(callee) ||
      callee.getName() !== versioning.call.method
    ) {
      return;
    }
    calls.push(
      versioningSetBy(node.getArguments()[0], versioning, modules, resolution),
    );
  });
  return { applications, calls };
}

/**
 * What every file in the run says, settled. No call with an application
 * in the run means versioning is off. No application at all, or calls
 * that disagree, leave it unread.
 */
export function agreedVersioning(
  found: readonly VersioningInFile[],
): AppVersioning {
  const calls = found.flatMap((file) => file.calls);
  const first = calls[0];
  if (first === undefined) {
    const applications = found.some((file) => file.applications > 0);
    return applications ? { kind: "off" } : UNREAD_APP;
  }
  const described = describeVersioning(first);
  return calls.every((call) => describeVersioning(call) === described)
    ? first
    : UNREAD_APP;
}

function versioningSetBy(
  options: Node | undefined,
  versioning: RouteVersioning,
  modules: string[],
  resolution: ResolutionStore,
): AppVersioning {
  if (options === undefined) {
    return {
      kind: "on",
      placement: versioning.defaultType,
      pathPrefix: versioning.pathPrefix.default,
      defaultVersion: UNSTATED,
    };
  }
  const object = objectLiteralOf(options, resolution);
  if (object === null) {
    return UNREAD_APP;
  }
  const type = propertyOf(object, versioning.typeKey, resolution);
  const placement =
    type === null ? null : placementOf(type, versioning, modules, resolution);
  if (placement === null) {
    return UNREAD_APP;
  }
  const pathPrefix = pathPrefixOf(
    propertyOf(object, versioning.pathPrefix.key, resolution),
    versioning.pathPrefix.default,
    resolution,
  );
  if (pathPrefix === null) {
    return UNREAD_APP;
  }
  const defaultVersion = propertyOf(
    object,
    versioning.defaultVersionKey,
    resolution,
  );
  return {
    kind: "on",
    placement,
    pathPrefix,
    defaultVersion:
      defaultVersion === null
        ? UNSTATED
        : statedVersionOf(defaultVersion, versioning, modules, resolution),
  };
}

function placementOf(
  value: Node,
  versioning: RouteVersioning,
  modules: string[],
  resolution: ResolutionStore,
): VersionPlacement | null {
  for (const path of libraryExportPathsOf(value, modules, resolution)) {
    const found = versioning.types[path];
    if (found !== undefined) {
      return found;
    }
  }
  const number = numberValueOf(value, resolution);
  return number === null ? null : (versioning.typeNumbers[number] ?? null);
}

function pathPrefixOf(
  value: Node | null,
  fallback: string,
  resolution: ResolutionStore,
): string | null {
  if (value === null) {
    return fallback;
  }
  const settled = evaluatedValue(value, resolution);
  if (constantOf(settled) === false) {
    return "";
  }
  return literalOf(settled);
}

/**
 * The versions a value states: one version, a list of them, or the
 * library's export for every version. A list with an entry that does
 * not settle to a string is unread as a whole.
 */
export function statedVersionOf(
  value: Node,
  versioning: RouteVersioning,
  modules: string[],
  resolution: ResolutionStore | undefined,
): StatedVersion {
  const entries = arrayElementsOf(value, resolution) ?? [value];
  const versions: Array<string | null> = [];
  for (const entry of entries) {
    if (
      libraryExportPathsOf(entry, modules, resolution).includes(
        versioning.neutral,
      )
    ) {
      versions.push(null);
      continue;
    }
    const version = stringValueOf(entry, resolution);
    if (version === null) {
      return UNREAD_VERSION;
    }
    versions.push(version);
  }
  return { kind: "listed", versions };
}

/**
 * The versions a class decorator's options state. A path written as a
 * plain string states none.
 */
export function classVersionOf(
  args: readonly Node[],
  versioning: RouteVersioning,
  modules: string[],
  resolution: ResolutionStore | undefined,
): StatedVersion {
  const [first] = args;
  if (first === undefined) {
    return UNSTATED;
  }
  const object = objectLiteralOf(first, resolution);
  if (object === null) {
    const value = evaluatedValue(first, resolution);
    const mayState =
      value.kind === "record" &&
      (value.open || value.fields.has(versioning.option));
    return mayState ? UNREAD_VERSION : UNSTATED;
  }
  const stated = propertyOf(object, versioning.option, resolution);
  return stated === null
    ? UNSTATED
    : statedVersionOf(stated, versioning, modules, resolution);
}

/** The version segments each route in one file is served under. */
export interface RouteVersions {
  segmentsFor(
    classArgs: readonly Node[],
    routeDecorator: Node,
  ): ReadonlyArray<string | null> | null;
}

export function routeVersionsReader(
  sourceFile: SourceFile,
  versioning: RouteVersioning,
  modules: string[],
  resolution: ResolutionStore | undefined,
  index: MountPrefixIndex | undefined,
): RouteVersions {
  const app = versioningOf(index, routeVersioningKey(versioning));
  const decorators = [
    ...importedDecoratorLocals(sourceFile, modules, [
      versioning.decorator,
    ]).keys(),
  ];
  return {
    segmentsFor(classArgs, routeDecorator) {
      if (app.kind === "off") {
        return [null];
      }
      const stated =
        methodVersionOf(
          routeDecorator,
          decorators,
          versioning,
          modules,
          resolution,
        ) ?? classVersionOf(classArgs, versioning, modules, resolution);
      return versionSegmentsOf(app, stated);
    },
  };
}

/** What the version decorator on the route's own method states, when it has one. */
function methodVersionOf(
  routeDecorator: Node,
  decorators: readonly string[],
  versioning: RouteVersioning,
  modules: string[],
  resolution: ResolutionStore | undefined,
): StatedVersion | null {
  const member = routeDecorator.getParent();
  if (member === undefined || !Node.isMethodDeclaration(member)) {
    return null;
  }
  for (const name of decorators) {
    const decorator = member.getDecorator(name);
    if (decorator === undefined) {
      continue;
    }
    const [argument] = decorator.getArguments();
    return argument === undefined
      ? UNREAD_VERSION
      : statedVersionOf(argument, versioning, modules, resolution);
  }
  return null;
}

/**
 * The path segment each version the route serves puts in front of its
 * path, with null for no segment. Null overall when the run cannot tell
 * which paths the route is served at.
 */
export function versionSegmentsOf(
  app: AppVersioning,
  stated: StatedVersion,
): ReadonlyArray<string | null> | null {
  if (app.kind === "off") {
    return [null];
  }
  if (app.kind === "unread") {
    const everyVersion =
      stated.kind === "unstated" ||
      (stated.kind === "listed" && stated.versions.every((v) => v === null));
    return everyVersion ? [null] : null;
  }
  const served = stated.kind === "unstated" ? app.defaultVersion : stated;
  if (served.kind === "unread") {
    return null;
  }
  if (served.kind === "unstated" || app.placement === "outsidePath") {
    return [null];
  }
  const segments = served.versions.map((version) =>
    version === null ? null : `${app.pathPrefix}${version}`,
  );
  return [...new Set(segments)];
}
