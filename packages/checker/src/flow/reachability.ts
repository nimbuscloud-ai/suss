// Flow reachability: who a request reaches, walked as rules over the
// facts `collectFlowInputs` reads off a summary set.
//
// The split is the one the flow-reachability proposal draws. The
// engine holds tuples and joins them by equality, so it cannot run a
// matcher or pick a winner; deciding which match takes the request is
// settled in TypeScript first, per router, by the selector for the
// router's own condition language. The walk over settled edges is
// recursive, which is what the engine is for, so that part is rules:
// a fixpoint over a finite node set, which is also why a cycle of
// edges terminates instead of looping.
//
// Certainty is two relations, never a guess. `reaches` walks edges
// whose match took the request outright; `mayReach` also walks edges
// whose match could take it once a condition nobody here evaluates is
// decided at runtime. Everything `reaches` derives, `mayReach` derives
// too, so "possible but not certain" is a set difference the reader
// takes, and an unevaluated condition can never turn a reachable
// answer into an unreachable one.

import { Database, evaluate, lit, rule, variable as v } from "@suss/datalog";
import { servesRequest } from "@suss/ir-core";

import { buildFlowChains } from "./flowChains.js";
import { collectFlowInputs, scopedFlowNode } from "./routingFacts.js";

import type {
  BehavioralSummary,
  FlowRequest,
  RouterMatchSelector,
} from "@suss/behavioral-ir";
import type { Rule } from "@suss/datalog";
import type {
  FlowChain,
  FlowChainsOmitted,
  FlowServingClaim,
} from "./flowChains.js";
import type {
  AnsweredMatch,
  FlowInputs,
  RouterMatches,
} from "./routingFacts.js";

export const FLOW_RULES: Rule[] = [
  // One settled hop: an admitted forward, what a target group fronts,
  // or a fronted balancer handing to its own listeners.
  rule(
    "step",
    [v("x"), v("y")],
    [lit("routesTo", v("x"), v("y"), v("m")), lit("admits", v("m"))],
  ),
  rule("step", [v("x"), v("y")], [lit("fronts", v("x"), v("y"))]),
  rule("step", [v("x"), v("y")], [lit("belongsTo", v("y"), v("x"))]),

  // A hop that might carry the request: every settled hop, plus a
  // forward whose match is possible rather than admitted.
  rule("hop", [v("x"), v("y")], [lit("step", v("x"), v("y"))]),
  rule(
    "hop",
    [v("x"), v("y")],
    [lit("routesTo", v("x"), v("y"), v("m")), lit("mayAdmit", v("m"))],
  ),

  rule("reaches", [v("x"), v("y")], [lit("step", v("x"), v("y"))]),
  rule(
    "reaches",
    [v("x"), v("z")],
    [lit("reaches", v("x"), v("y")), lit("step", v("y"), v("z"))],
  ),
  rule("mayReach", [v("x"), v("y")], [lit("hop", v("x"), v("y"))]),
  rule(
    "mayReach",
    [v("x"), v("z")],
    [lit("mayReach", v("x"), v("y")), lit("hop", v("y"), v("z"))],
  ),

  // A terminal response: an admitted answers action on the entry
  // itself or on any router the walk reaches.
  rule(
    "reachesAnswer",
    [v("x"), v("m")],
    [lit("answers", v("x"), v("m")), lit("admits", v("m"))],
  ),
  rule(
    "reachesAnswer",
    [v("x"), v("m")],
    [
      lit("reaches", v("x"), v("r")),
      lit("answers", v("r"), v("m")),
      lit("admits", v("m")),
    ],
  ),
  rule(
    "mayReachAnswer",
    [v("x"), v("m")],
    [lit("answers", v("x"), v("m")), lit("admits", v("m"))],
  ),
  rule(
    "mayReachAnswer",
    [v("x"), v("m")],
    [lit("answers", v("x"), v("m")), lit("mayAdmit", v("m"))],
  ),
  rule(
    "mayReachAnswer",
    [v("x"), v("m")],
    [
      lit("mayReach", v("x"), v("r")),
      lit("answers", v("r"), v("m")),
      lit("admits", v("m")),
    ],
  ),
  rule(
    "mayReachAnswer",
    [v("x"), v("m")],
    [
      lit("mayReach", v("x"), v("r")),
      lit("answers", v("r"), v("m")),
      lit("mayAdmit", v("m")),
    ],
  ),

  // A serving claim inside a reached unit whose own protocol says it
  // answers (or might answer) the request.
  rule(
    "servedBy",
    [v("x"), v("c")],
    [
      lit("reaches", v("x"), v("u")),
      lit("serves", v("u"), v("c")),
      lit("admitsServe", v("c")),
    ],
  ),
  rule(
    "mayServedBy",
    [v("x"), v("c")],
    [
      lit("mayReach", v("x"), v("u")),
      lit("serves", v("u"), v("c")),
      lit("admitsServe", v("c")),
    ],
  ),
  rule(
    "mayServedBy",
    [v("x"), v("c")],
    [
      lit("mayReach", v("x"), v("u")),
      lit("serves", v("u"), v("c")),
      lit("mayServe", v("c")),
    ],
  ),
];

/** Names, split by what the declarations can say: `certain` holds, `possible` waits on something undeclared. */
export interface FlowEndpointSets {
  certain: string[];
  possible: string[];
}

/** What one entry's walk found for the request. */
export interface FlowView {
  /** Every node an edge chain connects the entry to: routers, targets, resources. */
  nodes: FlowEndpointSets;
  /** The reached nodes that are deployable units (a code scope was declared for them). */
  units: FlowEndpointSets;
  /** Terminal responses: answers actions the request lands on. */
  answers: { certain: AnsweredMatch[]; possible: AnsweredMatch[] };
  /** Serving claims (`file::name`) inside reached units that answer the request. */
  claims: FlowEndpointSets;
  /** The same answer as a route: each path the request takes, hop by hop. */
  chains: FlowChain[];
  /** Chains beyond the ones kept, so an answer can say it is not the whole of it. */
  omitted: FlowChainsOmitted;
}

/** A node a question can start from: one that hands traffic on and takes none. */
export interface FlowEntry {
  name: string;
  /** The document that declared it, which is also the scope its walk stays inside. */
  scope: string;
}

export interface FlowAnalysis {
  /**
   * The view from one entry node, a client-facing listener being the
   * usual one. A bare `entry` resolves against every document in the
   * summary set; when two documents both declare the name, the caller
   * has to say which document it is asking about by passing that
   * summary's root document label as `documentScope`, because merging
   * them would answer one stack's question from another stack's rules.
   */
  from(entry: string, documentScope?: string): FlowView;
  /**
   * Where a request can come in: every node that hands traffic on and
   * is handed none, which is the balancer or router a client reaches
   * first. Sorted by name, then by document.
   */
  entries(): FlowEntry[];
  /**
   * The documents that declare a node of this name. More than one and
   * `from` needs to be told which, since neither document's rules may
   * answer the other's question.
   */
  scopesOf(entry: string): string[];
}

interface Admissions {
  admits: Set<string>;
  may: Set<string>;
}

/**
 * The language a router's matches can be selected by: the one language
 * every row named, or undefined when the rows disagree or named none.
 */
function routerLanguage(matches: RouterMatches): string | undefined {
  if (matches.languages.size !== 1) {
    return undefined;
  }

  const [only] = matches.languages;
  return only;
}

/**
 * Settle each router's matches for the request. A router whose
 * language has a selector in the table gets that selector's answer.
 * A router with no usable selector abstains: every one of its matches
 * stays possible, never admitted and never refused, the same standing
 * an unevaluated condition has.
 *
 * A selector sees and answers with the bare matchIds its document
 * wrote; the admission sets carry them scoped, so two documents'
 * same-named matches stay two admissions.
 */
function selectAdmissions(
  routers: Map<string, RouterMatches>,
  selectors: Record<string, RouterMatchSelector>,
  request: FlowRequest,
): Admissions {
  const admits = new Set<string>();
  const may = new Set<string>();
  for (const matches of routers.values()) {
    const language = routerLanguage(matches);
    const selector = language === undefined ? undefined : selectors[language];
    if (selector === undefined) {
      for (const matchId of matches.records.keys()) {
        may.add(scopedFlowNode(matches.scope, matchId));
      }

      continue;
    }

    const selection = selector([...matches.records.values()], request);
    for (const matchId of selection.admitted) {
      if (matches.records.has(matchId)) {
        admits.add(scopedFlowNode(matches.scope, matchId));
      }
    }

    for (const matchId of selection.possible) {
      if (matches.records.has(matchId)) {
        may.add(scopedFlowNode(matches.scope, matchId));
      }
    }
  }
  return { admits, may };
}

/**
 * Which serving claims answer the request, and how surely, placed in
 * the units that hold them. Whether a claim answers is its own
 * protocol's question, asked once here and used by both the walk and
 * the chains behind it.
 */
interface ServingIndex {
  byUnit: Map<string, FlowServingClaim[]>;
  byRef: Map<string, FlowServingClaim>;
}

function indexServingClaims(
  inputs: FlowInputs,
  request: FlowRequest,
): ServingIndex {
  const index: ServingIndex = { byUnit: new Map(), byRef: new Map() };
  for (const claim of inputs.claims) {
    const outcome = servesRequest(claim.binding, request.method, request.path);
    if (outcome === null || outcome === "nomatch") {
      continue;
    }

    const serving: FlowServingClaim = {
      ref: claim.ref,
      certainty: outcome === "match" ? "certain" : "possible",
    };
    index.byRef.set(claim.ref, serving);
    for (const unit of claim.units) {
      const node = scopedFlowNode(unit.scope, unit.instanceName);
      index.byUnit.set(node, [...(index.byUnit.get(node) ?? []), serving]);
    }
  }
  return index;
}

function assertFacts(
  db: Database,
  inputs: FlowInputs,
  admissions: Admissions,
  serving: ServingIndex,
): void {
  for (const tuple of inputs.edges.routesTo) {
    db.add("routesTo", tuple);
  }

  for (const tuple of inputs.edges.fronts) {
    db.add("fronts", tuple);
  }

  for (const tuple of inputs.edges.belongsTo) {
    db.add("belongsTo", tuple);
  }

  for (const [scopedMatchId, scoped] of inputs.edges.answers) {
    db.add("answers", [scoped.router, scopedMatchId]);
  }

  for (const matchId of admissions.admits) {
    db.add("admits", [matchId]);
  }

  for (const matchId of admissions.may) {
    db.add("mayAdmit", [matchId]);
  }

  for (const [unitNode, claims] of serving.byUnit) {
    for (const claim of claims) {
      db.add("serves", [unitNode, claim.ref]);
    }
  }

  for (const claim of serving.byRef.values()) {
    db.add(claim.certainty === "certain" ? "admitsServe" : "mayServe", [
      claim.ref,
    ]);
  }
}

function targetsOf(db: Database, relation: string, entry: string): Set<string> {
  const found = new Set<string>();
  for (const tuple of db.lookup(relation, 0, entry)) {
    found.add(String(tuple[1]));
  }
  return found;
}

/**
 * A view's name lists, rendered bare. Every node one view holds shares
 * the entry's document scope, because edges never cross scopes, so
 * stripping the scope for display loses nothing a reader needed.
 */
function endpointSets(
  certain: Set<string>,
  may: Set<string>,
  bare: (key: string) => string,
): FlowEndpointSets {
  const possible = [...may].filter((key) => !certain.has(key));
  return {
    certain: [...certain].map(bare).sort(),
    possible: possible.map(bare).sort(),
  };
}

/**
 * The scoped node a query's entry names, or null when the name is
 * declared nowhere. A bare name declared by two documents is refused
 * rather than resolved, because whichever document was picked, the
 * other stack's question would be answered from the wrong rules.
 */
function resolveEntry(
  inputs: FlowInputs,
  entry: string,
  documentScope: string | undefined,
): string | null {
  if (documentScope !== undefined) {
    return scopedFlowNode(documentScope, entry);
  }

  const scopes = inputs.nodeScopes.get(entry);
  if (scopes === undefined) {
    return null;
  }

  if (scopes.size > 1) {
    const listed = [...scopes].sort().join(", ");
    throw new Error(
      `${scopes.size} documents declare a node named "${entry}" (${listed}); pass the document scope to say which one the question is about`,
    );
  }

  const [only] = scopes;
  return scopedFlowNode(only, entry);
}

const EMPTY_VIEW: FlowView = {
  nodes: { certain: [], possible: [] },
  units: { certain: [], possible: [] },
  answers: { certain: [], possible: [] },
  claims: { certain: [], possible: [] },
  chains: [],
  omitted: { count: 0, exact: true },
};

/**
 * The nodes traffic can enter by: those with an edge out and none in.
 * A listener belongs to its balancer, so the balancer is the entry and
 * its listeners sit one hop in.
 */
function entryNodes(inputs: FlowInputs): FlowEntry[] {
  const entered = new Set<string>();
  const leaves = new Set<string>();
  for (const [router, target] of inputs.edges.routesTo) {
    entered.add(target);
    leaves.add(router);
  }

  for (const [target, resource] of inputs.edges.fronts) {
    entered.add(resource);
    leaves.add(target);
  }

  for (const [listener, balancer] of inputs.edges.belongsTo) {
    entered.add(listener);
    leaves.add(balancer);
  }

  // A node whose only edge out is one nothing could follow still hands
  // traffic on, and is still where a question starts.
  for (const node of inputs.edges.unfollowed.keys()) {
    leaves.add(node);
  }

  const entries: FlowEntry[] = [];
  for (const node of leaves) {
    if (entered.has(node)) {
      continue;
    }

    const [scope, name] = splitFlowNode(node, inputs);
    entries.push({ name, scope });
  }
  return entries.sort(
    (a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope),
  );
}

/** A scoped node key read back as the document that declared it and the name it wrote. */
function splitFlowNode(node: string, inputs: FlowInputs): [string, string] {
  const name = inputs.nodeNames.get(node) ?? node;
  return [node.slice(0, Math.max(node.length - name.length - 2, 0)), name];
}

/**
 * Walk the summary set's routing edges for one request. `selectors`
 * maps each condition language to the selector its reader exports;
 * the walk itself never interprets a condition or a priority. The
 * result answers per entry, where an entry is any node the caller
 * starts from, a client-facing listener being the usual one.
 */
export function analyzeFlow(
  summaries: BehavioralSummary[],
  request: FlowRequest,
  selectors: Record<string, RouterMatchSelector>,
): FlowAnalysis {
  const inputs = collectFlowInputs(summaries);
  const admissions = selectAdmissions(inputs.edges.routers, selectors, request);
  const serving = indexServingClaims(inputs, request);
  const db = new Database();
  assertFacts(db, inputs, admissions, serving);
  evaluate(db, FLOW_RULES);

  return {
    entries: (): FlowEntry[] => entryNodes(inputs),
    scopesOf: (entry: string): string[] =>
      [...(inputs.nodeScopes.get(entry) ?? [])].sort(),
    from(entry: string, documentScope?: string): FlowView {
      const entryNode = resolveEntry(inputs, entry, documentScope);
      if (entryNode === null) {
        return EMPTY_VIEW;
      }

      const bare = (key: string): string => inputs.nodeNames.get(key) ?? key;
      const certainNodes = targetsOf(db, "reaches", entryNode);
      const mayNodes = targetsOf(db, "mayReach", entryNode);
      const isUnit = (key: string): boolean => inputs.units.has(key);

      const certainAnswers = targetsOf(db, "reachesAnswer", entryNode);
      const mayAnswers = targetsOf(db, "mayReachAnswer", entryNode);
      const answered = (scopedMatchId: string): AnsweredMatch =>
        inputs.edges.answers.get(scopedMatchId)?.answer ?? {
          matchId: scopedMatchId,
          router: entry,
        };
      const byMatchId = (a: AnsweredMatch, b: AnsweredMatch): number =>
        a.matchId.localeCompare(b.matchId);
      const walked = buildFlowChains(
        {
          inputs,
          admits: admissions.admits,
          mayAdmit: admissions.may,
          serving: serving.byUnit,
          reachable: new Set([entryNode, ...mayNodes]),
        },
        entryNode,
      );

      return {
        nodes: endpointSets(certainNodes, mayNodes, bare),
        units: endpointSets(
          new Set([...certainNodes].filter(isUnit)),
          new Set([...mayNodes].filter(isUnit)),
          bare,
        ),
        answers: {
          certain: [...certainAnswers].map(answered).sort(byMatchId),
          possible: [...mayAnswers]
            .filter((scopedMatchId) => !certainAnswers.has(scopedMatchId))
            .map(answered)
            .sort(byMatchId),
        },
        claims: endpointSets(
          targetsOf(db, "servedBy", entryNode),
          targetsOf(db, "mayServedBy", entryNode),
          (key) => key,
        ),
        chains: walked.chains,
        omitted: walked.omitted,
      };
    },
  };
}
