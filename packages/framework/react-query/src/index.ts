/**
 * Links a component to the function its TanStack Query hook runs, so the
 * HTTP call inside `queryFn` is tied to the component. An inline function
 * becomes a sub-unit for the client packs to read, and a named one is
 * recorded by identifier for the walk to follow. The README lists the
 * hooks and what is left out.
 */

import { callbacks, constructedFrom, pack } from "@suss/recognize";

import type { PackDeclaration } from "@suss/ir-core";
import type { CallbackPick, PatternPack } from "@suss/recognize";

const QUERY = constructedFrom("@tanstack/react-query", "react-query");

/**
 * Where a hook states its function, tried argument by argument: the
 * options object's own `property`, or, from `from` on, a function or a
 * name written as the argument. In the v3 positional form the query key
 * comes first, and `useMutation` takes its function first. Three
 * arguments is the most any v3 signature takes.
 */
function functionAt(property: string, from: number): CallbackPick[] {
  return [0, 1, 2].flatMap((at): CallbackPick[] => [
    ...(at >= from ? [{ written: "callback" as const, at }] : []),
    { written: "here", at, property: [property] },
  ]);
}

const QUERY_FUNCTION = { callback: functionAt("queryFn", 1) };

const HOOKS = callbacks({ client: QUERY })
  .methods({
    useQuery: QUERY_FUNCTION,
    useSuspenseQuery: QUERY_FUNCTION,
    useInfiniteQuery: QUERY_FUNCTION,
    useSuspenseInfiniteQuery: QUERY_FUNCTION,
    useMutation: { callback: functionAt("mutationFn", 0) },
  })
  .schedules({
    via: "asWritten",
    unread: {
      missing: "missing-query-function",
      other: "non-literal-query-function",
    },
  })
  .unitWhenInPlace({
    kind: "scheduled-callback",
    name: ["parent", "callee", "countPerCallee"],
  })
  .example('useQuery({ queryKey: ["orders"], queryFn: fetchOrders })');

export function reactQueryFramework(): PatternPack {
  return pack("react-query", [HOOKS], {
    languages: ["typescript"],
    recognizedAs: "react-query",
  });
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-react-query",
  dependencies: [{ ecosystem: "npm", name: "@tanstack/react-query" }],
  reads:
    "TanStack Query hooks. The pack links a component to the query function that its \`useQuery\` or \`useMutation\` call runs.",
};

export default reactQueryFramework;
