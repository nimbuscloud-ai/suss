/**
 * The path an application puts in front of every route it serves.
 *
 * NestJS serves each decorated route under whatever the bootstrap's
 * `app.setGlobalPrefix("api")` says, in a file with no controller in it.
 * A call counts when the store says its receiver is the app the
 * framework's factory made, following a parameter to every caller. The
 * prefix and its exclusions are read through the value evaluator, and
 * every call in the run has to agree, or no prefix is applied.
 */

import { Node, type SourceFile } from "ts-morph";

import { constantOf, force, literalOf } from "@suss/values";

import { evaluatedValue } from "../values/evaluator.js";
import { writtenNodeOf } from "./resolveValue.js";
import { parameterNamedBy } from "./shared.js";

import type { GlobalPrefixCall } from "@suss/extractor";
import type { Value } from "@suss/values";
import type { CallExpression } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

/** A route the prefix leaves out. A null method leaves out every verb. */
export interface ExcludedRoute {
  path: string;
  method: string | null;
}

export interface GlobalPrefix {
  prefix: string;
  excluded: ExcludedRoute[];
}

const KEY_START = "global:";

/** What a run's recorded assumption about a pattern's global prefix is keyed by. */
export function globalPrefixKey(call: GlobalPrefixCall): string {
  const { importModule, importName, factory } = call.application;
  return `${KEY_START}${importModule}:${importName}.${factory}().${call.method}`;
}

/** Whether a recorded assumption is about a global prefix rather than a mount. */
export function isGlobalPrefixKey(id: string): boolean {
  return id.startsWith(KEY_START);
}

/** A prefix as one string, so a cached walk can tell whether it changed. */
export function describeGlobalPrefix(prefix: GlobalPrefix | null): string {
  return prefix === null ? "" : JSON.stringify(prefix);
}

/**
 * Every prefix the calls in this file set on the framework's
 * application. A call whose prefix does not read as one string gives
 * null, which keeps the run's calls from agreeing.
 */
export function globalPrefixesIn(
  sourceFile: SourceFile,
  call: GlobalPrefixCall,
  resolution: ResolutionStore,
): Array<GlobalPrefix | null> {
  if (!sourceFile.getFullText().includes(call.method)) {
    return [];
  }
  const found: Array<GlobalPrefix | null> = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    if (
      !Node.isPropertyAccessExpression(callee) ||
      callee.getName() !== call.method ||
      !isApplication(callee.getExpression(), call, resolution)
    ) {
      return;
    }
    found.push(prefixSetBy(node, call, resolution));
  });
  return found;
}

/** The one prefix every call agrees on, or null when there is none or they differ. */
export function agreedGlobalPrefix(
  found: ReadonlyArray<GlobalPrefix | null>,
): GlobalPrefix | null {
  const first = found[0];
  if (first === undefined || first === null) {
    return null;
  }
  const described = describeGlobalPrefix(first);
  for (const other of found) {
    if (describeGlobalPrefix(other) !== described) {
      return null;
    }
  }
  return first;
}

/** The path a route is served at once the prefix is put in front of it. */
export function pathUnderGlobalPrefix(
  prefix: GlobalPrefix | null,
  method: string | null,
  path: string,
): string {
  if (prefix === null || trimSlashes(prefix.prefix) === "") {
    return path;
  }
  for (const route of prefix.excluded) {
    if (excludes(route, method, path)) {
      return path;
    }
  }
  const route = trimSlashes(path);
  const base = `/${trimSlashes(prefix.prefix)}`;
  return route === "" ? base : `${base}/${route}`;
}

/**
 * Whether the receiver is an application the factory made: written as
 * the factory's call, or a parameter every caller passes one to.
 */
function isApplication(
  receiver: Node,
  call: GlobalPrefixCall,
  resolution: ResolutionStore,
): boolean {
  const parameter = parameterNamedBy(receiver);
  if (parameter === null) {
    return madeByFactory(receiver, call, resolution);
  }
  const passed = resolution.argumentsPassedTo(parameter);
  if (passed.length === 0) {
    return false;
  }
  for (const { argument } of passed) {
    if (!madeByFactory(argument, call, resolution)) {
      return false;
    }
  }
  return true;
}

function madeByFactory(
  value: Node,
  call: GlobalPrefixCall,
  resolution: ResolutionStore,
): boolean {
  const written = writtenNodeOf(value, resolution);
  return written !== null && isFactoryCall(written, call, resolution);
}

function isFactoryCall(
  value: Node,
  call: GlobalPrefixCall,
  resolution: ResolutionStore,
): boolean {
  if (!Node.isCallExpression(value)) {
    return false;
  }
  const callee = value.getExpression();
  const { importModule, importName, factory } = call.application;
  return (
    Node.isPropertyAccessExpression(callee) &&
    callee.getName() === factory &&
    resolution
      .importedNamesOf(callee.getExpression(), [importModule])
      .includes(importName)
  );
}

function prefixSetBy(
  node: CallExpression,
  call: GlobalPrefixCall,
  resolution: ResolutionStore,
): GlobalPrefix | null {
  const [prefixArg, optionsArg] = node.getArguments();
  if (prefixArg === undefined) {
    return null;
  }
  const prefix = literalOf(evaluatedValue(prefixArg, resolution));
  if (prefix === null) {
    return null;
  }
  const excluded =
    optionsArg === undefined || call.exclude === undefined
      ? []
      : excludedRoutes(evaluatedValue(optionsArg, resolution), call.exclude);
  return { prefix, excluded };
}

type ExcludeOption = NonNullable<GlobalPrefixCall["exclude"]>;

/**
 * The routes the options leave out. An entry that does not read as a
 * path is dropped, which leaves that route prefixed.
 */
function excludedRoutes(
  options: Value,
  exclude: ExcludeOption,
): ExcludedRoute[] {
  const list = fieldValue(options, exclude.option);
  if (list === null || list.kind !== "sequence") {
    return [];
  }
  const routes: ExcludedRoute[] = [];
  for (const item of list.items) {
    const route = excludedRoute(force(item.value), exclude);
    if (route !== null) {
      routes.push(route);
    }
  }
  return routes;
}

function excludedRoute(
  entry: Value,
  exclude: ExcludeOption,
): ExcludedRoute | null {
  const path = literalOf(entry);
  if (path !== null) {
    return { path, method: null };
  }
  const pathValue = fieldValue(entry, exclude.pathKey);
  const routePath = pathValue === null ? null : literalOf(pathValue);
  if (routePath === null) {
    return null;
  }
  const methodValue = fieldValue(entry, exclude.methodKey);
  const code = methodValue === null ? undefined : constantOf(methodValue);
  const method = typeof code === "number" ? exclude.methods[code] : undefined;
  return {
    path: routePath,
    method: method === undefined || method === "*" ? null : method,
  };
}

function fieldValue(record: Value, key: string): Value | null {
  if (record.kind !== "record") {
    return null;
  }
  const field = record.fields.get(key);
  return field === undefined ? null : force(field.value);
}

// Nest has spelled a trailing wildcard several ways across its versions.
const WILDCARD_TAIL = /\/?(?:\(\.\*\)|\{\*[^}]*\}|\*\w*)$/;

function excludes(
  route: ExcludedRoute,
  method: string | null,
  path: string,
): boolean {
  if (route.method !== null && route.method !== method) {
    return false;
  }
  const served = segmentsOf(path);
  const wildcard = WILDCARD_TAIL.exec(route.path);
  const listed = segmentsOf(
    wildcard === null ? route.path : route.path.slice(0, wildcard.index),
  );
  const lengthFits =
    wildcard === null
      ? listed.length === served.length
      : listed.length <= served.length;
  if (!lengthFits) {
    return false;
  }
  for (const [i, segment] of listed.entries()) {
    if (!segmentsMatch(segment, served[i])) {
      return false;
    }
  }
  return true;
}

function segmentsMatch(listed: string, served: string | undefined): boolean {
  if (served === undefined) {
    return false;
  }
  return (
    listed === served || (listed.startsWith(":") && served.startsWith(":"))
  );
}

function segmentsOf(path: string): string[] {
  return trimSlashes(path)
    .split("/")
    .filter((segment) => segment !== "");
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}
