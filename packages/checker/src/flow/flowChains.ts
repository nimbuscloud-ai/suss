// The chain behind a reachability answer: which hops the request took,
// what admitted each one, and what happened at the end.
//
// The fixpoint in `reachability.ts` answers which nodes a request can
// get to. A person asking who serves a URL wants the route as well, so
// this pass walks the same edges the fixpoint walked and records each
// step, with the match record that carried it. It never widens the
// answer: a step is only taken into a node the fixpoint already put in
// reach, so the chains and the sets cannot drift apart.
//
// Certainty travels with each hop. A hop whose match took the request
// outright is certain, a hop whose match could take it once something
// undeclared is decided at runtime is possible, and a chain is only as
// certain as its least certain hop and its end.

import { scopedFlowNode } from "./routingFacts.js";

import type {
  RoutingMatchCondition,
  RoutingMatchRecord,
} from "@suss/behavioral-ir";
import type { AnsweredMatch, FlowInputs } from "./routingFacts.js";

/** Settled by the declarations, or waiting on something they do not say. */
export type FlowCertainty = "certain" | "possible";

/** Which kind of declaration carried a hop. */
export type FlowEdgeKind = "routesTo" | "fronts" | "belongsTo";

/** The match a router chose, as the reader wrote it down. */
export interface FlowHopMatch {
  matchId: string;
  priority?: number;
  conditions: RoutingMatchCondition[];
}

/** One step of a chain, from one node to the next. */
export interface FlowHop {
  from: string;
  to: string;
  edge: FlowEdgeKind;
  certainty: FlowCertainty;
  /** Present when a router picked this hop; absent when the wiring itself is the reason. */
  match?: FlowHopMatch;
}

/** A provider inside a reached unit that answers the request. */
export interface FlowServingClaim {
  /** `file::name`, the way findings name a summary. */
  ref: string;
  certainty: FlowCertainty;
}

/**
 * How a chain finishes. A chain that neither serves nor answers still
 * ends somewhere, and saying where is the useful part: the last node
 * the request got to, and what was declared there that refused it.
 */
export type FlowEnd =
  | { type: "serves"; unit: string; claims: FlowServingClaim[] }
  | {
      type: "answers";
      router: string;
      answer: AnsweredMatch;
      certainty: FlowCertainty;
    }
  | { type: "unserved"; unit: string }
  | { type: "stops"; node: string; refused: RoutingMatchRecord[] }
  | { type: "loops"; node: string };

export interface FlowChain {
  entry: string;
  hops: FlowHop[];
  end: FlowEnd;
  certainty: FlowCertainty;
}

/** What the walk settled for this request, keyed the way the walk keys nodes. */
export interface FlowChainContext {
  inputs: FlowInputs;
  /** Scoped match ids whose match took the request outright. */
  admits: Set<string>;
  /** Scoped match ids whose match could take it. */
  mayAdmit: Set<string>;
  /** Serving claims per scoped unit, for the units something serves. */
  serving: Map<string, FlowServingClaim[]>;
  /** The scoped nodes the fixpoint put in reach of this entry. */
  reachable: Set<string>;
}

/**
 * How many chains one question is answered with. A template whose
 * every rule is possible can branch wide, and a terminal that scrolls
 * for a page answers nobody.
 */
const MAX_CHAINS = 50;

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

/** Every edge out of each node, in one table, ordered so an answer reads the same twice. */
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

  // A balancer hands the request to the listeners that belong to it, so
  // the walk reads the declaration the other way round.
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

/**
 * Build the chains one entry's request takes. Each chain is a path of
 * hops, and where a path branches, each branch is its own chain.
 */
export function buildFlowChains(
  ctx: FlowChainContext,
  entryNode: string,
): FlowChain[] {
  const adjacency = adjacencyOf(ctx.inputs);
  const bare = (key: string): string => ctx.inputs.nodeNames.get(key) ?? key;
  const chains: FlowChain[] = [];

  const record = (hops: FlowHop[], end: FlowEnd, certainty: FlowCertainty) => {
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
    if (chains.length >= MAX_CHAINS) {
      return;
    }

    const answered = recordAnswers(ctx, node, hops, record);
    const served = recordServing(ctx, node, hops, record);
    const onward = takeable(ctx, adjacency.get(node) ?? []);
    if (onward.length === 0) {
      // A node that answered or served has said what happens to the
      // request; the rules it also refused are not the story there.
      if (!served && !answered) {
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
  return chains;
}

/** The edges out of a node the request can take: refused matches are not among them. */
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

/** The record behind a scoped match id, found through its own router's scope. */
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

/**
 * A declared response the request lands on at this node ends a chain
 * here. Says whether any did.
 */
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

/** A unit whose own boundaries answer the request ends a chain there. */
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

/**
 * Why a chain got no further: what this node declared and none of it
 * took the request. A node that declared nothing at all leaves the list
 * empty, which reads as the wiring ending here.
 */
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
