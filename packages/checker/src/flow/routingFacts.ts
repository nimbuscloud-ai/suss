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
//
// Every node the walk joins on is keyed by (document scope, name),
// never by the bare name. A logical id is unique inside one document
// and nowhere else, so two unrelated stacks that both declare an
// `HttpListener` are two nodes, and neither can answer for the other.
// The scope is the root document label read off the summary's own
// provenance (`rootDocumentLabel`), so every document of one nested
// tree shares one scope and joins within the tree still hold. The
// summaries themselves keep their bare names; only the walk's keying
// is scoped.

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

/** An answers row as a reader sees it: bare names, the way its document wrote them. */
export interface AnsweredMatch {
  matchId: string;
  router: string;
  response?: RoutingResponse;
}

/** An answers row keyed for the walk: the scoped router node beside the bare record. */
export interface ScopedAnswer {
  router: string;
  answer: AnsweredMatch;
}

/**
 * Every match one router declares, with every condition language its
 * rows name. `router` is the scoped node; the records keep their bare
 * matchIds, which is what the language's own selector ranks.
 */
export interface RouterMatches {
  router: string;
  scope: string;
  languages: Set<string | undefined>;
  records: Map<string, RoutingMatchRecord>;
}

export interface RoutingEdgeFacts {
  /**
   * [router, target, matchId] rows that carry traffic when their match
   * wins, every column scoped. A row declared with weight 0 carries
   * none by its own declaration, so it stays out of the walk; the
   * summary still records it.
   */
  routesTo: [string, string, string][];
  /** [target, resource], scoped. */
  fronts: [string, string][];
  /** [listener, loadBalancer], scoped. */
  belongsTo: [string, string][];
  /** Keyed by the scoped matchId. */
  answers: Map<string, ScopedAnswer>;
  /** Keyed by the scoped router node. */
  routers: Map<string, RouterMatches>;
}

/** One deployable unit as a walk node: its document scope and the bare instance name. */
export interface ScopedUnit {
  scope: string;
  instanceName: string;
}

/** A provider summary that might answer a request inside a unit. */
export interface ServingClaimSite {
  /** `file::name`, the way findings name a summary. */
  ref: string;
  binding: BoundaryBinding;
  /** The units whose code scope holds this claim. */
  units: ScopedUnit[];
}

export interface FlowInputs {
  edges: RoutingEdgeFacts;
  /** Scoped node keys of every resource some summary declares a code scope for: the walk's notion of a deployable unit. */
  units: Set<string>;
  claims: ServingClaimSite[];
  /** Bare name of every scoped node key, for rendering a view. */
  nodeNames: Map<string, string>;
  /** Which document scopes declare each bare node name, for resolving a query's entry. */
  nodeScopes: Map<string, Set<string>>;
}

/** The scoped key one document's node joins under. */
export function scopedFlowNode(scope: string, name: string): string {
  return `${scope}::${name}`;
}

/** The document scope a summary's nodes belong to: the root label of its own provenance. */
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
    scope: string,
    inputs: FlowInputs,
  ) => void;
};

const EDGE_READERS: EdgeReaders = {
  routesTo(routing, scope, inputs) {
    recordMatch(routing, scope, inputs);
    if (
      unset(routing.router) ||
      unset(routing.target) ||
      unset(routing.matchId) ||
      routing.weight === 0
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

/**
 * File a routesTo / answers row under its router's matches. A weighted
 * forward's rows share one matchId and one match record: the match
 * admits the request, and which target then carries it is the edges'
 * business. Every language the router's rows name is kept, because a
 * router whose rows disagree has no one selector to trust.
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

// ---------------------------------------------------------------------------
// Units and serving claims
// ---------------------------------------------------------------------------

interface NamedUnitScope {
  unit: ScopedUnit;
  scope: UnitScope;
}

/**
 * The unit scopes the summary set declares: one per summary that names
 * both a deployable unit and the code scope deployed into it, deduped
 * by scoped instance name.
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
 * Deployable units become walk nodes, and provider summaries are
 * placed into the units whose code scope holds them. Whether a claim
 * would answer any particular request is its protocol's question,
 * asked per query; placement is the part that does not change between
 * queries. A provider no unit holds claims nothing the walk can
 * reach, so it stays out.
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
