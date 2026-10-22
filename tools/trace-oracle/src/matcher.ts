/**
 * Compares each traced edge with what suss says its route reaches, and
 * gives every miss one reason.
 *
 * The reasons are tried in order and the first that fits wins, so the
 * order is the ranking: a route suss never found hides everything
 * behind it, and a library with no pack hides every table it touches.
 * The README explains what evidence each reason rests on.
 */

import { displayLabel } from "@suss/behavioral-ir";

import { agreement, SEMANTICS_FOR, sameStore, unsettled } from "./agreement.js";
import { entryKey, targetKey } from "./edges.js";

import type { BoundaryBinding } from "@suss/behavioral-ir";
import type { Agreement } from "./agreement.js";
import type { EdgeKind, RouteEntry, Target, TracedEdge } from "./edges.js";
import type { Reach, RouteMatch, SussSide, Walk } from "./sussSide.js";

export type MissReason =
  | "routeNotDiscovered"
  | "noPack"
  | "nameNotSettled"
  | "dynamicDispatch"
  | "wrapperOrFactory"
  | "other";

export const REASON_LABEL: Record<MissReason, string> = {
  routeNotDiscovered: "route not discovered",
  noPack: "no pack for the library",
  nameNotSettled: "the table name not settled",
  dynamicDispatch: "dynamic dispatch",
  wrapperOrFactory: "wrapper or factory not read",
  other: "other",
};

export interface EdgeVerdict {
  edge: string;
  kind: EdgeKind;
  route: string;
  target: string;
  requests: number;
  found: boolean;
  tableFromRequest: boolean;
  /** How the found boundary agreed with the span: byte for byte, or by the model and table name rule. */
  agreement?: Exclude<Agreement, null>;
  /** The suss boundary that matched, and the calls `ask` says lead to it. */
  via?: { label: string; through: string[]; possible: boolean };
  reason?: MissReason;
  detail?: string;
  /** The library the span came from, as its instrumentation scope says. */
  library: string;
  evidence: TracedEdge["evidence"];
}

export interface NotExercised {
  route: string;
  boundary: string;
}

/** `@opentelemetry/instrumentation-knex` and `opentelemetry.instrumentation.sqlalchemy` both become the library's own name. */
export function scopeLibrary(scope: string): string {
  const tail = scope.split(/instrumentation[-._:]+/i).pop() ?? scope;
  return tail === "" ? scope : tail.replace(/^[-._:]+/, "").toLowerCase();
}

function firstFew(items: readonly string[], count = 3): string {
  const unique = [...new Set(items)];
  const shown = unique.slice(0, count).join(", ");
  return unique.length > count
    ? `${shown} and ${unique.length - count} more`
    : shown;
}

interface MatchContext {
  side: SussSide;
  match: RouteMatch;
  reaches: Reach[];
  walk: Walk | null;
}

function found(
  reaches: readonly Reach[],
  target: Target,
): { reach: Reach; agreement: Exclude<Agreement, null> } | null {
  let byName: { reach: Reach; agreement: "byName" } | null = null;
  for (const reach of reaches) {
    for (const binding of reach.bindings) {
      const agreed = agreement(binding, target);
      if (agreed === "exact") {
        return { reach, agreement: agreed };
      }
      if (agreed === "byName" && byName === null) {
        byName = { reach, agreement: agreed };
      }
    }
  }
  return byName;
}

function reasonFor(
  edge: TracedEdge,
  context: MatchContext,
): { reason: MissReason; detail: string } {
  const target = edge.target;
  if (context.match.routes.length === 0) {
    return {
      reason: "routeNotDiscovered",
      detail: `no suss route agrees with ${entryKey(edge.entry)}`,
    };
  }
  const anywhere = context.side.allInteractionBindings();
  if (!anywhere.some((binding) => sameStore(binding, target))) {
    return {
      reason: "noPack",
      detail: `no unit in the run crosses a ${SEMANTICS_FOR[target.kind]} boundary on ${systemOf(target)}`,
    };
  }
  if (edge.tableFromRequest === true) {
    return {
      reason: "nameNotSettled",
      detail:
        "the request path gives the table, so only a hole can stand for it",
    };
  }
  const unsettledReach = context.reaches.find((reach) =>
    reach.bindings.some(
      (binding) =>
        sameStore(binding, target) && unsettled(binding, target.kind),
    ),
  );
  if (unsettledReach !== undefined) {
    return {
      reason: "nameNotSettled",
      detail: `the route reaches ${unsettledReach.label} with no settled name`,
    };
  }
  const elsewhere = context.side.touching
    .filter((entry) =>
      entry.bindings.some((binding) => agreement(binding, target) !== null),
    )
    .map(
      (entry) => `${entry.unit.identity.name} (${entry.unit.location.file})`,
    );
  const walk = context.walk;
  if (
    walk !== null &&
    walk.dispatched.length > 0 &&
    (elsewhere.length > 0 || walk.unfollowed.length === 0)
  ) {
    return {
      reason: "dynamicDispatch",
      detail: `the walk from the route picks a function at run time at ${firstFew(walk.dispatched.map((call) => call.callee))}${elsewhere.length > 0 ? `; ${firstFew(elsewhere)} touches ${targetKey(target)}` : ""}`,
    };
  }
  if (elsewhere.length > 0) {
    const stops =
      walk === null ? [] : walk.unfollowed.map((call) => call.callee);
    return {
      reason: "wrapperOrFactory",
      detail: `${firstFew(elsewhere)} touches ${targetKey(target)}, and no call chain from the route leads there${stops.length > 0 ? `; the walk stops at ${firstFew(stops)}` : ""}`,
    };
  }
  if (walk !== null && walk.unfollowed.length > 0) {
    return {
      reason: "wrapperOrFactory",
      detail: `nothing in the run touches ${targetKey(target)}, and the walk from the route stops at ${firstFew(walk.unfollowed.map((call) => call.callee))}`,
    };
  }
  const sameStoreReach = context.reaches.filter((reach) =>
    reach.bindings.some((binding) => sameStore(binding, target)),
  );
  return {
    reason: "other",
    detail:
      sameStoreReach.length > 0
        ? `the route reaches ${firstFew(sameStoreReach.map((reach) => reach.label))} on this store, and never ${targetKey(target)}`
        : `nothing in the run touches ${targetKey(target)}, and the walk from the route has no unfollowed call`,
  };
}

function systemOf(target: Target): string {
  if (target.kind === "storage") {
    return target.system;
  }
  return target.kind === "http"
    ? target.host
    : (target.system ?? target.destination);
}

export interface MatchResult {
  verdicts: EdgeVerdict[];
  notExercised: NotExercised[];
  routesMatched: Map<string, RouteMatch>;
}

export function matchEdges(
  side: SussSide,
  edges: readonly TracedEdge[],
  routes: ReadonlyArray<{ entry: RouteEntry; requests: number }>,
): MatchResult {
  const routesMatched = new Map<string, RouteMatch>();
  const requestsByRoute = new Map(
    routes.map((route) => [entryKey(route.entry), route.requests]),
  );
  for (const route of routes) {
    routesMatched.set(entryKey(route.entry), side.matchRoute(route.entry));
  }
  const verdicts: EdgeVerdict[] = [];
  const walks = new Map<string, Walk>();
  for (const edge of edges) {
    const key = entryKey(edge.entry);
    const match = routesMatched.get(key) ?? side.matchRoute(edge.entry);
    const reaches = match.routes.flatMap((route) => side.reachOf(route));
    const hit = found(reaches, edge.target);
    const base = {
      edge: `${key} -> ${targetKey(edge.target)}`,
      kind: edge.target.kind,
      route: key,
      target: targetKey(edge.target),
      requests: requestsByRoute.get(key) ?? 0,
      tableFromRequest: edge.tableFromRequest === true,
      library: scopeLibrary(edge.evidence[0]?.scope ?? ""),
      evidence: edge.evidence,
    };
    if (hit !== null) {
      verdicts.push({
        ...base,
        found: true,
        agreement: hit.agreement,
        via: {
          label: hit.reach.label,
          through: hit.reach.through,
          possible: hit.reach.possible,
        },
      });
      continue;
    }
    let walk = walks.get(key) ?? null;
    if (walk === null && match.routes.length > 0) {
      walk = side.walkOf(match.routes);
      walks.set(key, walk);
    }
    verdicts.push({
      ...base,
      found: false,
      ...reasonFor(edge, { side, match, reaches, walk }),
    });
  }
  return {
    verdicts,
    notExercised: notExercised(side, edges, routesMatched),
    routesMatched,
  };
}

/** What suss says an exercised route reaches that no request in the trace reached. */
function notExercised(
  side: SussSide,
  edges: readonly TracedEdge[],
  routesMatched: ReadonlyMap<string, RouteMatch>,
): NotExercised[] {
  const found: NotExercised[] = [];
  for (const [route, match] of routesMatched) {
    const traced = edges.filter((edge) => entryKey(edge.entry) === route);
    const seen = new Set<string>();
    for (const reach of match.routes.flatMap((one) => side.reachOf(one))) {
      const kinds = reach.bindings.filter(isReachKind);
      if (kinds.length === 0 || seen.has(reach.label)) {
        continue;
      }
      seen.add(reach.label);
      const exercised = traced.some((edge) =>
        kinds.some((binding) => agreement(binding, edge.target) !== null),
      );
      if (!exercised) {
        found.push({ route, boundary: reach.label });
      }
    }
  }
  return found;
}

function isReachKind(binding: BoundaryBinding): boolean {
  return (
    Object.values(SEMANTICS_FOR).includes(binding.semantics.name) &&
    displayLabel(binding) !== ""
  );
}
