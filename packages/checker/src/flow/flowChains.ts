// flowChains.ts: the chain behind a reachability answer, meaning which
// hops the request took, what admitted each one, and what happened at
// the end.
//
// The fixpoint in `reachability.ts` settles which nodes a request can
// get to. A person asking who serves a URL wants the route as well, so
// this pass walks the same edges the fixpoint walked and records each
// step together with the match record that admitted it. It never
// widens the answer: a step is only taken into a node the fixpoint
// already put in reach, so the chains and the sets cannot drift apart.
//
// Certainty travels with each hop. A hop whose match took the request
// outright is certain. A hop whose match could take it once something
// undeclared is decided at runtime is possible. A chain is only as
// certain as its least certain hop and its end.

import { scopedFlowNode } from "./routingFacts.js";

import type {
  RoutingMatchCondition,
  RoutingMatchRecord,
} from "@suss/behavioral-ir";
import type {
  AnsweredMatch,
  FlowInputs,
  UnfollowedEdge,
} from "./routingFacts.js";

/** `possible` is waiting on a condition nobody here evaluates. */
export type FlowCertainty = "certain" | "possible";

export type FlowEdgeKind = "routesTo" | "fronts" | "belongsTo";

export interface FlowHopMatch {
  matchId: string;
  priority?: number;
  conditions: RoutingMatchCondition[];
}

export interface FlowHop {
  from: string;
  to: string;
  edge: FlowEdgeKind;
  certainty: FlowCertainty;
  /** Absent when the wiring itself made the hop and no match picked it. */
  match?: FlowHopMatch;
}

export interface FlowServingClaim {
  /** `file::name`, the way findings refer to a summary. */
  ref: string;
  certainty: FlowCertainty;
}

export type FlowEnd =
  | { type: "serves"; unit: string; claims: FlowServingClaim[] }
  | {
      type: "answers";
      router: string;
      answer: AnsweredMatch;
      certainty: FlowCertainty;
    }
  | { type: "unserved"; unit: string }
  | { type: "unfollowed"; node: string; edges: UnfollowedEdge[] }
  | { type: "stops"; node: string; refused: RoutingMatchRecord[] }
  | { type: "loops"; node: string };

export interface FlowChain {
  entry: string;
  hops: FlowHop[];
  end: FlowEnd;
  certainty: FlowCertainty;
}

export interface FlowChainsOmitted {
  count: number;
  /** False when the walk stopped enumerating, so `count` is a floor. */
  exact: boolean;
}

export interface FlowChains {
  chains: FlowChain[];
  omitted: FlowChainsOmitted;
}

/** Every key here is a scoped node or a scoped match id. */
export interface FlowChainContext {
  inputs: FlowInputs;
  admits: Set<string>;
  mayAdmit: Set<string>;
  serving: Map<string, FlowServingClaim[]>;
  reachable: Set<string>;
}

const MAX_CHAINS = 50;

const MAX_CHAINS_FOUND = 500;

interface Adjacency {
  to: string;
  edge: FlowEdgeKind;
  matchId?: string;
}

function chainCertainty(hops: FlowHop[], end: FlowCertainty): FlowCertainty {
  return hops.every((hop) => hop.certainty === "certain") && end === "certain"
    ? "certain"
    : "possible";
}

function adjacencyOf(inputs: FlowInputs): Map<string, Adjacency[]> {
  const out = new Map<string, Adjacency[]>();
  const add = (from: string, edge: Adjacency): void => {
    const edges = out.get(from) ?? [];
    edges.push(edge);
    out.set(from, edges);
  };

  for (const [router, target, matchId] of inputs.edges.routesTo) {
    add(router, { to: target, edge: "routesTo", matchId });
  }

  for (const [target, resource] of inputs.edges.fronts) {
    add(target, { to: resource, edge: "fronts" });
  }

  // A balancer hands the request to its listeners, so the walk takes
  // the declaration the other way round.
  for (const [listener, balancer] of inputs.edges.belongsTo) {
    add(balancer, { to: listener, edge: "belongsTo" });
  }

  for (const edges of out.values()) {
    edges.sort(
      (a, b) =>
        a.to.localeCompare(b.to) ||
        (a.matchId ?? "").localeCompare(b.matchId ?? ""),
    );
  }
  return out;
}

export function buildFlowChains(
  ctx: FlowChainContext,
  entryNode: string,
): FlowChains {
  const adjacency = adjacencyOf(ctx.inputs);
  const bare = (key: string): string => ctx.inputs.nodeNames.get(key) ?? key;
  const chains: FlowChain[] = [];
  let found = 0;

  const record = (hops: FlowHop[], end: FlowEnd, certainty: FlowCertainty) => {
    found += 1;
    if (chains.length >= MAX_CHAINS) {
      return;
    }

    chains.push({
      entry: bare(entryNode),
      hops,
      end,
      certainty: chainCertainty(hops, certainty),
    });
  };

  const walk = (node: string, hops: FlowHop[], onPath: Set<string>): void => {
    if (found >= MAX_CHAINS_FOUND) {
      return;
    }

    const answered = recordAnswers(ctx, node, hops, record);
    const served = recordServing(ctx, node, hops, record);
    const lost = recordUnfollowed(ctx, node, hops, bare, record);
    const onward = takeable(ctx, adjacency.get(node) ?? []);
    if (onward.length === 0) {
      if (!served && !answered && !lost) {
        record(hops, terminalEnd(ctx, node, bare), "certain");
      }

      return;
    }

    for (const edge of onward) {
      if (onPath.has(edge.to)) {
        record(hops, { type: "loops", node: bare(edge.to) }, "certain");
        continue;
      }

      walk(
        edge.to,
        [...hops, hopOf(ctx, node, edge, bare)],
        new Set([...onPath, edge.to]),
      );
    }
  };

  walk(entryNode, [], new Set([entryNode]));
  return {
    chains,
    omitted: {
      count: found - chains.length,
      exact: found < MAX_CHAINS_FOUND,
    },
  };
}

function takeable(ctx: FlowChainContext, edges: Adjacency[]): Adjacency[] {
  return edges.filter((edge) => {
    if (!ctx.reachable.has(edge.to)) {
      return false;
    }

    if (edge.matchId === undefined) {
      return true;
    }

    return ctx.admits.has(edge.matchId) || ctx.mayAdmit.has(edge.matchId);
  });
}

function matchRecordOf(
  ctx: FlowChainContext,
  routerNode: string,
  scopedMatchId: string,
): RoutingMatchRecord | undefined {
  const matches = ctx.inputs.edges.routers.get(routerNode);
  if (matches === undefined) {
    return undefined;
  }

  return [...matches.records.values()].find(
    (record) => scopedFlowNode(matches.scope, record.matchId) === scopedMatchId,
  );
}

function hopOf(
  ctx: FlowChainContext,
  from: string,
  edge: Adjacency,
  bare: (key: string) => string,
): FlowHop {
  const match =
    edge.matchId === undefined
      ? undefined
      : matchRecordOf(ctx, from, edge.matchId);
  return {
    from: bare(from),
    to: bare(edge.to),
    edge: edge.edge,
    certainty:
      edge.matchId !== undefined && !ctx.admits.has(edge.matchId)
        ? "possible"
        : "certain",
    ...(match !== undefined ? { match } : {}),
  };
}

type ChainRecorder = (
  hops: FlowHop[],
  end: FlowEnd,
  certainty: FlowCertainty,
) => void;

function recordAnswers(
  ctx: FlowChainContext,
  node: string,
  hops: FlowHop[],
  record: ChainRecorder,
): boolean {
  let answered = false;
  for (const [scopedMatchId, scoped] of ctx.inputs.edges.answers) {
    if (scoped.router !== node) {
      continue;
    }

    const certainty = ctx.admits.has(scopedMatchId)
      ? "certain"
      : ctx.mayAdmit.has(scopedMatchId)
        ? "possible"
        : null;
    if (certainty === null) {
      continue;
    }

    record(
      hops,
      {
        type: "answers",
        router: scoped.answer.router,
        answer: scoped.answer,
        certainty,
      },
      certainty,
    );
    answered = true;
  }

  return answered;
}

function recordUnfollowed(
  ctx: FlowChainContext,
  node: string,
  hops: FlowHop[],
  bare: (key: string) => string,
  record: ChainRecorder,
): boolean {
  const taken = (ctx.inputs.edges.unfollowed.get(node) ?? []).filter(
    (edge) =>
      edge.scopedMatchId === null ||
      ctx.admits.has(edge.scopedMatchId) ||
      ctx.mayAdmit.has(edge.scopedMatchId),
  );
  if (taken.length === 0) {
    return false;
  }

  const certainty = taken.every(
    (edge) => edge.scopedMatchId === null || ctx.admits.has(edge.scopedMatchId),
  )
    ? "certain"
    : "possible";
  record(
    hops,
    { type: "unfollowed", node: bare(node), edges: taken },
    certainty,
  );
  return true;
}

function recordServing(
  ctx: FlowChainContext,
  node: string,
  hops: FlowHop[],
  record: ChainRecorder,
): boolean {
  if (!ctx.inputs.units.has(node)) {
    return false;
  }

  const unit = ctx.inputs.nodeNames.get(node) ?? node;
  const claims = ctx.serving.get(node) ?? [];
  if (claims.length === 0) {
    record(hops, { type: "unserved", unit }, "certain");
    return true;
  }

  const certainty = claims.some((claim) => claim.certainty === "certain")
    ? "certain"
    : "possible";
  record(hops, { type: "serves", unit, claims }, certainty);
  return true;
}

function terminalEnd(
  ctx: FlowChainContext,
  node: string,
  bare: (key: string) => string,
): FlowEnd {
  const matches = ctx.inputs.edges.routers.get(node);
  if (matches === undefined) {
    return { type: "stops", node: bare(node), refused: [] };
  }

  const refused = [...matches.records.values()].filter((record) => {
    const scoped = scopedFlowNode(matches.scope, record.matchId);
    return !ctx.admits.has(scoped) && !ctx.mayAdmit.has(scoped);
  });
  return { type: "stops", node: bare(node), refused };
}
