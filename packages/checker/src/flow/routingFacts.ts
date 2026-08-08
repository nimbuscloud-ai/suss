// routingFacts.ts: what the reachability walk needs, read once off a
// summary set.
//
// That means the routing edges as joinable tuples, each router's match
// records grouped for its language's selector, the resources that are
// deployable units, and the serving claims placed inside those units.
//
// Everything here reads the routing metadata namespace and the
// summaries' own identity fields. Nothing here mentions a protocol or a
// resource kind. An edge with an unresolved end contributes no tuple,
// because there is nothing to join it on, and the summary still keeps
// the unresolved record for a reader to render.
//
// Every node the walk joins on is keyed by (document scope, name),
// never by the bare name. A logical id is unique inside one document
// and nowhere else, so two unrelated stacks that both declare an
// `HttpListener` are two separate nodes, and neither can stand in for
// the other. The scope is the root document label read off the
// summary's own provenance (`rootDocumentLabel`), so every document of
// one nested tree shares one scope and joins within the tree still
// work. The summaries themselves keep their bare names; only the walk's
// keying is scoped.

import {
  BOUNDARY_ROLE,
  readRoutingMetadata,
  rootDocumentLabel,
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

/** Bare names, the way the document wrote them. */
export interface AnsweredMatch {
  matchId: string;
  router: string;
  response?: RoutingResponse;
}

export interface ScopedAnswer {
  /** Scoped node. */
  router: string;
  answer: AnsweredMatch;
}

/** `router` is the scoped node; the records keep their bare matchIds. */
export interface RouterMatches {
  router: string;
  scope: string;
  languages: Set<string | undefined>;
  records: Map<string, RoutingMatchRecord>;
}

/** Every column of every row here is a scoped node key. */
export interface RoutingEdgeFacts {
  /** [router, target, matchId]. A row declared with weight 0 stays out. */
  routesTo: [string, string, string][];
  /** [target, resource]. */
  fronts: [string, string][];
  /** [listener, loadBalancer]. */
  belongsTo: [string, string][];
  /** Keyed by the scoped matchId. */
  answers: Map<string, ScopedAnswer>;
  /** Keyed by the scoped router node. */
  routers: Map<string, RouterMatches>;
  /** Keyed by the scoped node the edge leaves. */
  unfollowed: Map<string, UnfollowedEdge[]>;
}

/**
 * An edge whose far end nothing resolved, such as a reference to a
 * resource another template owns. The walk cannot take it, and dropping
 * it would look like nothing being declared at that node.
 */
export interface UnfollowedEdge {
  /** Null when the wiring itself declares the edge, with no match to take. */
  matchId: string | null;
  scopedMatchId: string | null;
  reference: string | null;
  reason: string | null;
}

export interface ScopedUnit {
  scope: string;
  instanceName: string;
}

export interface ServingClaimSite {
  /** `file::name`. */
  ref: string;
  binding: BoundaryBinding;
  /** The units whose code scope contains this claim. */
  units: ScopedUnit[];
}

export interface FlowInputs {
  edges: RoutingEdgeFacts;
  /** Scoped keys of every node some summary declares a code scope for. */
  units: Set<string>;
  claims: ServingClaimSite[];
  /** Bare name of every scoped node key. */
  nodeNames: Map<string, string>;
  /** Which document scopes declare each bare node name. */
  nodeScopes: Map<string, Set<string>>;
}

export function scopedFlowNode(scope: string, name: string): string {
  return `${scope}::${name}`;
}

/** The root label, so every document of one nested tree shares one scope. */
function documentScopeOf(summary: BehavioralSummary): string {
  return rootDocumentLabel(summary.location.file);
}

export function collectFlowInputs(summaries: BehavioralSummary[]): FlowInputs {
  const inputs: FlowInputs = {
    edges: {
      routesTo: [],
      fronts: [],
      belongsTo: [],
      answers: new Map(),
      routers: new Map(),
      unfollowed: new Map(),
    },
    units: new Set(),
    claims: [],
    nodeNames: new Map(),
    nodeScopes: new Map(),
  };
  collectEdges(summaries, inputs);
  collectUnitsAndClaims(summaries, inputs);
  return inputs;
}

function registerNode(inputs: FlowInputs, scope: string, name: string): string {
  const key = scopedFlowNode(scope, name);
  inputs.nodeNames.set(key, name);
  const scopes = inputs.nodeScopes.get(name) ?? new Set<string>();
  scopes.add(scope);
  inputs.nodeScopes.set(name, scopes);
  return key;
}

/** An edge end that is missing or unresolved, either way not joinable. */
function unset(value: string | null | undefined): value is null | undefined {
  return value === null || value === undefined;
}

type EdgeReaders = {
  [K in RoutingMetadata["edge"]]: (
    routing: RoutingMetadata,
    scope: string,
    inputs: FlowInputs,
  ) => void;
};

const EDGE_READERS: EdgeReaders = {
  routesTo(routing, scope, inputs) {
    recordMatch(routing, scope, inputs);
    if (routing.weight === 0) {
      return;
    }

    if (unset(routing.target) && !unset(routing.router)) {
      recordUnfollowed(inputs, registerNode(inputs, scope, routing.router), {
        matchId: routing.matchId ?? null,
        scopedMatchId: unset(routing.matchId)
          ? null
          : scopedFlowNode(scope, routing.matchId),
        reference: routing.unresolvedTarget?.reference ?? null,
        reason: routing.unresolvedTarget?.reason ?? null,
      });
      return;
    }

    if (
      unset(routing.router) ||
      unset(routing.target) ||
      unset(routing.matchId)
    ) {
      return;
    }

    inputs.edges.routesTo.push([
      registerNode(inputs, scope, routing.router),
      registerNode(inputs, scope, routing.target),
      scopedFlowNode(scope, routing.matchId),
    ]);
  },
  answers(routing, scope, inputs) {
    recordMatch(routing, scope, inputs);
    if (unset(routing.router) || unset(routing.matchId)) {
      return;
    }

    inputs.edges.answers.set(scopedFlowNode(scope, routing.matchId), {
      router: registerNode(inputs, scope, routing.router),
      answer: {
        matchId: routing.matchId,
        router: routing.router,
        ...(routing.response !== undefined
          ? { response: routing.response }
          : {}),
      },
    });
  },
  fronts(routing, scope, inputs) {
    if (unset(routing.resource) && !unset(routing.target)) {
      recordUnfollowed(inputs, registerNode(inputs, scope, routing.target), {
        matchId: null,
        scopedMatchId: null,
        reference: routing.unresolvedResource?.reference ?? null,
        reason: routing.unresolvedResource?.reason ?? null,
      });
      return;
    }

    if (unset(routing.target) || unset(routing.resource)) {
      return;
    }

    inputs.edges.fronts.push([
      registerNode(inputs, scope, routing.target),
      registerNode(inputs, scope, routing.resource),
    ]);
  },
  belongsTo(routing, scope, inputs) {
    if (unset(routing.router) || unset(routing.resource)) {
      return;
    }

    inputs.edges.belongsTo.push([
      registerNode(inputs, scope, routing.router),
      registerNode(inputs, scope, routing.resource),
    ]);
  },
};

function recordUnfollowed(
  inputs: FlowInputs,
  node: string,
  edge: UnfollowedEdge,
): void {
  inputs.edges.unfollowed.set(node, [
    ...(inputs.edges.unfollowed.get(node) ?? []),
    edge,
  ]);
}

/**
 * File a routesTo or answers row under its router's matches. Every
 * language the router's rows mention is kept, because a router whose
 * rows disagree has no single selector to trust.
 */
function recordMatch(
  routing: RoutingMetadata,
  scope: string,
  inputs: FlowInputs,
): void {
  if (unset(routing.router) || unset(routing.matchId)) {
    return;
  }

  const routerNode = registerNode(inputs, scope, routing.router);
  const matches = inputs.edges.routers.get(routerNode) ?? {
    router: routerNode,
    scope,
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
  inputs.edges.routers.set(routerNode, matches);
}

function collectEdges(
  summaries: BehavioralSummary[],
  inputs: FlowInputs,
): void {
  for (const summary of summaries) {
    const routing = readRoutingMetadata(summary);
    if (routing === undefined) {
      continue;
    }

    EDGE_READERS[routing.edge](routing, documentScopeOf(summary), inputs);
  }
}

interface NamedUnitScope {
  unit: ScopedUnit;
  scope: UnitScope;
}

/**
 * One per summary that gives both a deployable unit and the code scope
 * deployed into it, deduped by scoped instance name.
 */
function namedUnitScopes(summaries: BehavioralSummary[]): NamedUnitScope[] {
  const byNode = new Map<string, NamedUnitScope>();
  for (const summary of summaries) {
    const unit = summary.identity.deployableUnit;
    if (unit === undefined) {
      continue;
    }

    const documentScope = documentScopeOf(summary);
    const node = scopedFlowNode(documentScope, unit.instanceName);
    if (byNode.has(node)) {
      continue;
    }

    const codeScope = readCodeScope(summary);
    if (codeScope.kind !== "codeUri" || codeScope.path === undefined) {
      continue;
    }

    byNode.set(node, {
      unit: { scope: documentScope, instanceName: unit.instanceName },
      scope: { unit, codeScope: codeScope.path },
    });
  }
  return [...byNode.values()];
}

/**
 * Placement only. Whether a claim serves any particular request is a
 * question for its protocol, asked once per query.
 */
function collectUnitsAndClaims(
  summaries: BehavioralSummary[],
  inputs: FlowInputs,
): void {
  const scopes = namedUnitScopes(summaries);
  for (const named of scopes) {
    inputs.units.add(
      registerNode(inputs, named.unit.scope, named.unit.instanceName),
    );
  }

  if (scopes.length === 0) {
    return;
  }

  const byFile: UnitsByFile = unitsByFile(summaries);
  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null || BOUNDARY_ROLE[summary.kind] !== "provider") {
      continue;
    }

    const units = scopes
      .filter((named) => runsIn(summary, named.scope, byFile))
      .map((named) => named.unit);
    if (units.length === 0) {
      continue;
    }

    inputs.claims.push({ ref: summaryRef(summary), binding, units });
  }
}
