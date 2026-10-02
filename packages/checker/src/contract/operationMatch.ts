/**
 * Which handlers serve each operation a contract document declares.
 *
 * A document and the code that serves it often spell a path parameter
 * differently, `{id}` against `:pk` or `{team_id}` against `:id`, so an
 * operation meets every route of the same shape. Shape alone can join
 * two different resources, though: a document's `GET /relations/{id}`
 * and a route `GET /relations/:collection` that lists one collection's
 * relations. Where the parameters at some position disagree, and the
 * code serves the document's other methods for that path only at a
 * longer path below the route, the two describe different resources and
 * the route does not count as serving the operation.
 */

import { normalizePath, operationKey } from "@suss/ir-core";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/** Each operation, by its document summary, with the handlers that serve it. */
export function handlersServing(
  stubs: readonly BehavioralSummary[],
  handlers: readonly BehavioralSummary[],
): Map<BehavioralSummary, BehavioralSummary[]> {
  const byKey = new Map<string, BehavioralSummary[]>();
  for (const handler of handlers) {
    const key = keyOf(handler);
    if (key !== null) {
      byKey.set(key, [...(byKey.get(key) ?? []), handler]);
    }
  }

  const codeMethods = methodsByPath(handlers, false);
  const documentMethods = methodsByPath(stubs, true);
  const served = new Map<BehavioralSummary, BehavioralSummary[]>();
  for (const stub of stubs) {
    const key = keyOf(stub);
    const sameShape = key === null ? [] : (byKey.get(key) ?? []);
    const declared = documentMethods.get(pathKey(stub, stub.location.file));
    served.set(
      stub,
      sameShape.filter(
        (handler) =>
          namesAgree(restPath(stub), restPath(handler)) ||
          !keyedDeeper(restPath(handler), declared, codeMethods),
      ),
    );
  }
  return served;
}

/**
 * Whether the code serves, at a longer path below the route, a method
 * the document declares at the operation's path and the route itself
 * does not serve. The code then names one of these resources with more
 * segments than the document does, as `/relations/:collection/:field`
 * does where the document writes `/relations/{id}`.
 */
function keyedDeeper(
  route: string | null,
  declared: ReadonlySet<string> | undefined,
  codeMethods: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (route === null || declared === undefined) {
    return false;
  }
  const own = codeMethods.get(`|${route}`) ?? new Set<string>();
  if (own.has("*")) {
    return false;
  }
  const below = [...codeMethods].filter(([path]) =>
    path.startsWith(`|${route}/`),
  );
  return [...declared].some(
    (method) =>
      !own.has(method) && below.some(([, methods]) => methods.has(method)),
  );
}

function keyOf(summary: BehavioralSummary): string | null {
  const binding = summary.identity.boundaryBinding;
  return binding === null ? null : operationKey(binding);
}

interface RestRoute {
  method: string;
  path: string;
}

function restRoute(summary: BehavioralSummary): RestRoute | null {
  const semantics = summary.identity.boundaryBinding?.semantics;
  if (
    semantics?.name !== "rest" ||
    semantics.method === null ||
    semantics.path === null
  ) {
    return null;
  }
  return {
    method: semantics.method.toUpperCase(),
    path: normalizePath(semantics.path),
  };
}

function restPath(summary: BehavioralSummary): string | null {
  return restRoute(summary)?.path ?? null;
}

function pathKey(summary: BehavioralSummary, scope: string): string {
  return `${scope}|${restPath(summary) ?? ""}`;
}

/**
 * The methods served at each path, keyed by `pathKey`. Documents are kept
 * apart by file, since two documents can describe one path differently.
 */
function methodsByPath(
  summaries: readonly BehavioralSummary[],
  perFile: boolean,
): Map<string, Set<string>> {
  const methods = new Map<string, Set<string>>();
  for (const summary of summaries) {
    const route = restRoute(summary);
    if (route === null) {
      continue;
    }

    const key = pathKey(summary, perFile ? summary.location.file : "");
    const set = methods.get(key) ?? new Set<string>();
    set.add(route.method);
    methods.set(key, set);
  }
  return methods;
}

/**
 * Whether two paths of one shape name each parameter alike: the same
 * name, or one name inside the other, as `team_id` has `id`. Paths that
 * are not REST, or that have no parameters, agree.
 */
function namesAgree(a: string | null, b: string | null): boolean {
  if (a === null || b === null) {
    return true;
  }
  const left = parameterNames(a);
  const right = parameterNames(b);
  return left.every((name, i) => {
    const other = right[i];
    return (
      other === undefined ||
      name === other ||
      name.startsWith(other) ||
      name.endsWith(other) ||
      other.startsWith(name) ||
      other.endsWith(name)
    );
  });
}

function parameterNames(path: string): string[] {
  return [...path.matchAll(/\{([^{}?+*]*)[?+*]?\}/g)].map((match) =>
    (match[1] ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""),
  );
}
