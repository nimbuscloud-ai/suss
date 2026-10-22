/**
 * Compares each traced edge with what suss says its route reaches, and
 * gives every miss one reason.
 *
 * The reasons are tried in order and the first that fits wins, so the
 * order is the ranking: a route suss never found hides everything
 * behind it, and a library with no pack hides every table it touches.
 * The README explains what evidence each reason rests on.
 */

import { agreement, SEMANTICS_FOR, sameStore, unsettled } from "./agreement.js";
import { entryKey, targetKey } from "./edges.js";

import type { BoundaryBinding } from "@suss/behavioral-ir";
import type { Agreement } from "./agreement.js";
import type { EdgeKind, RouteEntry, Target, TracedEdge } from "./edges.js";
import type { SourceTree } from "./sourceTree.js";
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
  otherKind?: OtherKind;
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

/** The method a callee calls: `repo.findUser` and `self.find_user!` give `findUser` and `find_user!`. */
function methodName(callee: string): string {
  return callee.split(/[.:]/).pop()?.replace(/\(.*$/s, "").trim() ?? callee;
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
  tree: SourceTree;
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

/** The finer cause behind an `other`, so the report can count each one. */
export type OtherKind = "template" | "implicitLoad" | "untouched";

export const OTHER_LABEL: Record<OtherKind, string> = {
  template: "ran inside a template, which suss does not read",
  implicitLoad: "the ORM touched it on its own",
  untouched: "nothing in the run touches it",
};

interface Classified {
  reason: MissReason;
  detail: string;
  otherKind?: OtherKind;
}

function reasonFor(edge: TracedEdge, context: MatchContext): Classified {
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
  // Only a function that serves no route of its own can be the callee the walk missed.
  const touchingTarget = context.side.touching.filter((entry) =>
    entry.bindings.some((binding) => agreement(binding, target) !== null),
  );
  const callees = touchingTarget.filter(
    (entry) => entry.unit.identity.boundaryBinding?.semantics.name !== "rest",
  );
  const elsewhere = callees.map(
    (entry) => `${entry.unit.identity.name} (${entry.unit.location.file})`,
  );
  if (edge.duringRender === edge.count) {
    return {
      reason: "other",
      otherKind: "template",
      detail: `every span of it ran while ${firstFew(edge.templates.map((file) => context.tree.relative(file)))} rendered, and suss reads no template`,
    };
  }
  const walk = context.walk;
  // A stop counts against a unit only when it calls a method of that unit's name.
  const touchingNames = new Set(
    callees.map((entry) => entry.unit.identity.name),
  );
  const named = (call: { callee: string }): boolean =>
    touchingNames.has(methodName(call.callee));
  const dispatched = walk?.dispatched.filter(named) ?? [];
  if (dispatched.length > 0) {
    return {
      reason: "dynamicDispatch",
      detail: `the walk from the route reaches ${firstFew(dispatched.map((call) => call.callee))}, a call with more than one candidate, and ${firstFew(elsewhere)} touches ${targetKey(target)}`,
    };
  }
  if (elsewhere.length > 0) {
    const stops = walk?.unfollowed.filter(named) ?? [];
    return {
      reason: "wrapperOrFactory",
      detail: `${firstFew(elsewhere)} touches ${targetKey(target)}, and no call chain from the route leads there${stops.length > 0 ? `; the walk stops at ${firstFew(stops.map((call) => call.callee))}` : ""}`,
    };
  }
  // An access with no container, such as a commit, is on most routes, so it explains a miss only when no unit touches the target by name.
  const unsettledReach = context.reaches.find((reach) =>
    reach.bindings.some(
      (binding) =>
        sameStore(binding, target) && unsettled(binding, target.kind),
    ),
  );
  if (unsettledReach !== undefined && touchingTarget.length === 0) {
    return {
      reason: "nameNotSettled",
      detail: `no unit in the run touches ${targetKey(target)} by name, and the route reaches ${unsettledReach.label}, which has no settled name`,
    };
  }
  return otherVerdict(target, context, touchingTarget.length);
}

function otherVerdict(
  target: Target,
  context: MatchContext,
  routesTouching: number,
): Classified {
  const sameStoreReach = context.reaches.filter((reach) =>
    reach.bindings.some(
      (binding) =>
        sameStore(binding, target) && !unsettled(binding, target.kind),
    ),
  );
  const reached =
    sameStoreReach.length > 0
      ? `the route reaches ${firstFew(sameStoreReach.map((reach) => reach.label))} on this store, and never ${targetKey(target)}`
      : "the route reaches nothing on this store by name";
  if (routesTouching > 0) {
    return {
      reason: "other",
      otherKind: "implicitLoad",
      detail: `${reached}; only other routes touch ${targetKey(target)}, so the store likely touched it on its own, as an ORM cascade or a relationship load does`,
    };
  }
  return {
    reason: "other",
    otherKind: "untouched",
    detail: `${reached}; nothing in the run touches ${targetKey(target)}, so the call that does is one no pack recognizes, such as raw SQL or a database trigger${stopsNote(context.walk)}`,
  };
}

function stopsNote(walk: Walk | null): string {
  if (walk === null || walk.unfollowed.length === 0) {
    return "";
  }
  return `; the walk also stops at ${firstFew(walk.unfollowed.map((call) => call.callee))}`;
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
  /** Accesses with no container name on exercised routes, which no span can agree with. */
  unnamedReaches: number;
  routesMatched: Map<string, RouteMatch>;
}

export function matchEdges(
  side: SussSide,
  edges: readonly TracedEdge[],
  routes: ReadonlyArray<{ entry: RouteEntry; requests: number }>,
  tree: SourceTree,
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
      ...reasonFor(edge, { side, tree, match, reaches, walk }),
    });
  }
  const { named, unnamed } = notExercised(side, edges, routesMatched);
  return {
    verdicts,
    notExercised: named,
    unnamedReaches: unnamed,
    routesMatched,
  };
}

/**
 * What suss says an exercised route reaches that no request in the
 * trace reached. An access with no container, such as a commit, can
 * never agree with a span, so it is counted instead of listed.
 */
function notExercised(
  side: SussSide,
  edges: readonly TracedEdge[],
  routesMatched: ReadonlyMap<string, RouteMatch>,
): { named: NotExercised[]; unnamed: number } {
  const named: NotExercised[] = [];
  let unnamed = 0;
  for (const [route, match] of routesMatched) {
    const traced = edges.filter((edge) => entryKey(edge.entry) === route);
    const seen = new Set<string>();
    for (const reach of match.routes.flatMap((one) => side.reachOf(one))) {
      const kinds = reach.bindings.filter(
        (binding) => edgeKindOf(binding) !== undefined,
      );
      if (kinds.length === 0 || seen.has(reach.label)) {
        continue;
      }
      seen.add(reach.label);
      if (kinds.every((binding) => isUnnamed(binding))) {
        unnamed += 1;
        continue;
      }
      const exercised = traced.some((edge) =>
        kinds.some((binding) => agreement(binding, edge.target) !== null),
      );
      if (!exercised) {
        named.push({ route, boundary: reach.label });
      }
    }
  }
  return { named, unnamed };
}

function edgeKindOf(binding: BoundaryBinding): EdgeKind | undefined {
  return (Object.keys(SEMANTICS_FOR) as EdgeKind[]).find(
    (kind) => SEMANTICS_FOR[kind] === binding.semantics.name,
  );
}

function isUnnamed(binding: BoundaryBinding): boolean {
  const kind = edgeKindOf(binding);
  return kind !== undefined && unsettled(binding, kind);
}
