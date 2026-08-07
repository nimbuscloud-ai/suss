// What the reachability walk needs, read once off a summary set: the
// routing edges as joinable tuples, each router's match records
// grouped for its language's selector, the resources that are
// deployable units, and the serving claims placed inside those units.
//
// Everything here reads the routing metadata namespace and the
// summaries' own identity fields; nothing names a protocol or a
// resource kind. An edge with an unresolved end contributes no tuple,
// since there is nothing to join it on; the summary still carries the
// unresolved record for a reader to render.

import {
  BOUNDARY_ROLE,
  readRoutingMetadata,
  summaryRef,
} from "@suss/behavioral-ir";

import { readCodeScope, runsIn, unitsByFile } from "../scope/unitScope.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  RoutingMatchRecord,
  RoutingMetadata,
} from "@suss/behavioral-ir";
import type { UnitScope, UnitsByFile } from "../scope/unitScope.js";

type RoutingResponse = NonNullable<RoutingMetadata["response"]>;

/** An answers row: the router it responds from and what it declares it says. */
export interface AnsweredMatch {
  matchId: string;
  router: string;
  response?: RoutingResponse;
}

/** Every match one router declares, with every condition language its rows name. */
export interface RouterMatches {
  router: string;
  languages: Set<string | undefined>;
  records: Map<string, RoutingMatchRecord>;
}

export interface RoutingEdgeFacts {
  /**
   * [router, target, matchId] rows that carry traffic when their match
   * wins. A row declared with weight 0 carries none by its own
   * declaration, so it stays out of the walk; the summary still
   * records it.
   */
  routesTo: [string, string, string][];
  /** [target, resource] */
  fronts: [string, string][];
  /** [listener, loadBalancer] */
  belongsTo: [string, string][];
  answers: Map<string, AnsweredMatch>;
  routers: Map<string, RouterMatches>;
}

/** A provider summary that might answer a request inside a unit. */
export interface ServingClaimSite {
  /** `file::name`, the way findings name a summary. */
  ref: string;
  binding: BoundaryBinding;
  /** instanceNames of the units whose code scope holds this claim. */
  units: string[];
}

export interface FlowInputs {
  edges: RoutingEdgeFacts;
  /** Every resource some summary declares a code scope for: the walk's notion of a deployable unit. */
  units: Set<string>;
  claims: ServingClaimSite[];
}

export function collectFlowInputs(summaries: BehavioralSummary[]): FlowInputs {
  return {
    edges: collectEdges(summaries),
    units: collectUnits(summaries),
    claims: collectServingClaims(summaries),
  };
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/** Whether an edge end is missing or unresolved, either way not joinable. */
function unset(value: string | null | undefined): value is null | undefined {
  return value === null || value === undefined;
}

type EdgeReaders = {
  [K in RoutingMetadata["edge"]]: (
    routing: RoutingMetadata,
    edges: RoutingEdgeFacts,
  ) => void;
};

const EDGE_READERS: EdgeReaders = {
  routesTo(routing, edges) {
    recordMatch(routing, edges);
    if (
      unset(routing.router) ||
      unset(routing.target) ||
      unset(routing.matchId) ||
      routing.weight === 0
    ) {
      return;
    }

    edges.routesTo.push([routing.router, routing.target, routing.matchId]);
  },
  answers(routing, edges) {
    recordMatch(routing, edges);
    if (unset(routing.router) || unset(routing.matchId)) {
      return;
    }

    edges.answers.set(routing.matchId, {
      matchId: routing.matchId,
      router: routing.router,
      ...(routing.response !== undefined ? { response: routing.response } : {}),
    });
  },
  fronts(routing, edges) {
    if (unset(routing.target) || unset(routing.resource)) {
      return;
    }

    edges.fronts.push([routing.target, routing.resource]);
  },
  belongsTo(routing, edges) {
    if (unset(routing.router) || unset(routing.resource)) {
      return;
    }

    edges.belongsTo.push([routing.router, routing.resource]);
  },
};

/**
 * File a routesTo / answers row under its router's matches. A weighted
 * forward's rows share one matchId and one match record: the match
 * admits the request, and which target then carries it is the edges'
 * business. Every language the router's rows name is kept, because a
 * router whose rows disagree has no one selector to trust.
 */
function recordMatch(routing: RoutingMetadata, edges: RoutingEdgeFacts): void {
  if (unset(routing.router) || unset(routing.matchId)) {
    return;
  }

  const matches = edges.routers.get(routing.router) ?? {
    router: routing.router,
    languages: new Set<string | undefined>(),
    records: new Map<string, RoutingMatchRecord>(),
  };
  matches.languages.add(routing.matchLanguage);
  if (!matches.records.has(routing.matchId)) {
    matches.records.set(routing.matchId, {
      matchId: routing.matchId,
      ...(routing.priority !== undefined ? { priority: routing.priority } : {}),
      conditions: routing.conditions ?? [],
    });
  }
  edges.routers.set(routing.router, matches);
}

function collectEdges(summaries: BehavioralSummary[]): RoutingEdgeFacts {
  const edges: RoutingEdgeFacts = {
    routesTo: [],
    fronts: [],
    belongsTo: [],
    answers: new Map(),
    routers: new Map(),
  };
  for (const summary of summaries) {
    const routing = readRoutingMetadata(summary);
    if (routing === undefined) {
      continue;
    }

    EDGE_READERS[routing.edge](routing, edges);
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Units and serving claims
// ---------------------------------------------------------------------------

interface NamedUnitScope {
  instanceName: string;
  scope: UnitScope;
}

/**
 * The unit scopes the summary set declares: one per summary that names
 * both a deployable unit and the code scope deployed into it, deduped
 * by instance name.
 */
function namedUnitScopes(summaries: BehavioralSummary[]): NamedUnitScope[] {
  const byName = new Map<string, NamedUnitScope>();
  for (const summary of summaries) {
    const unit = summary.identity.deployableUnit;
    if (unit === undefined || byName.has(unit.instanceName)) {
      continue;
    }

    const codeScope = readCodeScope(summary);
    if (codeScope.kind !== "codeUri" || codeScope.path === undefined) {
      continue;
    }

    byName.set(unit.instanceName, {
      instanceName: unit.instanceName,
      scope: { unit, codeScope: codeScope.path },
    });
  }
  return [...byName.values()];
}

function collectUnits(summaries: BehavioralSummary[]): Set<string> {
  return new Set(namedUnitScopes(summaries).map((unit) => unit.instanceName));
}

/**
 * Provider summaries placed into the units whose code scope holds
 * them. Whether a claim would answer any particular request is its
 * protocol's question, asked per query; placement is the part that
 * does not change between queries. A provider no unit holds claims
 * nothing the walk can reach, so it stays out.
 */
function collectServingClaims(
  summaries: BehavioralSummary[],
): ServingClaimSite[] {
  const scopes = namedUnitScopes(summaries);
  if (scopes.length === 0) {
    return [];
  }

  const byFile: UnitsByFile = unitsByFile(summaries);
  const claims: ServingClaimSite[] = [];
  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null || BOUNDARY_ROLE[summary.kind] !== "provider") {
      continue;
    }

    const units = scopes
      .filter((unit) => runsIn(summary, unit.scope, byFile))
      .map((unit) => unit.instanceName);
    if (units.length === 0) {
      continue;
    }

    claims.push({ ref: summaryRef(summary), binding, units });
  }
  return claims;
}
