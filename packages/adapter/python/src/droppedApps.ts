/**
 * Whether an app a function builds is dropped when the function returns,
 * so nothing registered or mounted on it can serve a request. The router
 * index asks about a mount and discovery asks about a route, and both
 * answer through the shared `passedOn` rules in @suss/resolution.
 */

import { type DispatchTable, dispatchByType } from "@suss/ir-core";
import { staysInItsFunction } from "@suss/resolution";

import { enclosingFunction } from "./ast.js";
import { usesOf } from "./facts/resolve.js";
import { nameKeyIn } from "./facts/values.js";
import { resolutionKeyOf } from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type { PythonDiscoveryPattern } from "./pack.js";
import type { PyNode } from "./parser.js";

/** The route methods, `@app.get`, whichever way the pattern spells them. */
const ROUTE_METHODS: DispatchTable<PythonDiscoveryPattern, readonly string[]> =
  {
    decoratedFunctionRoute: (pattern) =>
      Object.keys(pattern.verbAttributeNames),
    decoratedClassRoute: (pattern) => [pattern.decoratorName],
  };

/**
 * Every method a pattern registers something on an app with: its route
 * verbs, its mount method and its wrapper decorators. Calling any other
 * method on an app, `run` say, may serve it.
 */
export function ownMethodsOf(pattern: PythonDiscoveryPattern): Set<string> {
  const wrappers = (pattern.wrappers ?? []).flatMap((form) =>
    form.type === "decoratedWrapper" ? [form.attribute] : [],
  );
  const mount = pattern.routerComposition?.includeMethodName;
  return new Set([
    ...dispatchByType(ROUTE_METHODS, pattern),
    ...(mount === undefined ? [] : [mount]),
    ...wrappers,
  ]);
}

/** Whether nothing the pack does not own reads the local at `nameKey`, and nothing passes it on. */
export function localStaysPut(
  facts: Database,
  nameKey: string,
  pattern: PythonDiscoveryPattern,
): boolean {
  return staysInItsFunction(usesOf(facts, nameKey), ownMethodsOf(pattern));
}

/**
 * Whether a route decorator is called on `object`, a local that a function
 * writes once, from `constructionKey`, and then drops. A module-level app
 * never is, since whoever imports the module may serve it.
 */
export function routeOnDroppedApp(
  facts: Database,
  object: PyNode,
  constructionKey: string,
  pattern: PythonDiscoveryPattern,
): boolean {
  const fn = enclosingFunction(object);
  const fnKey = fn === null ? null : resolutionKeyOf(fn, facts);
  const key = resolutionKeyOf(object, facts);
  if (
    fn === null ||
    fnKey === null ||
    key === null ||
    object.type !== "identifier" ||
    pattern.routerComposition?.mountObjectPrefix !== undefined
  ) {
    return false;
  }
  const filePath = fnKey.slice(0, fnKey.lastIndexOf(":"));
  if (key === nameKeyIn(filePath, null, object.text)) {
    return false;
  }
  const writes = facts.lookup("binds", 0, key);
  return (
    writes.length === 1 &&
    writes[0]?.[1] === constructionKey &&
    localStaysPut(facts, key, pattern)
  );
}
