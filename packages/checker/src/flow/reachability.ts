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

import { collectFlowInputs } from "./routingFacts.js";

import type {
  BehavioralSummary,
  FlowRequest,
  RouterMatchSelector,
} from "@suss/behavioral-ir";
import type { Rule } from "@suss/datalog";
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
}

export interface FlowAnalysis {
  from(entry: string): FlowView;
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
        may.add(matchId);
      }

      continue;
    }

    const selection = selector([...matches.records.values()], request);
    for (const matchId of selection.admitted) {
      if (matches.records.has(matchId)) {
        admits.add(matchId);
      }
    }

    for (const matchId of selection.possible) {
      if (matches.records.has(matchId)) {
        may.add(matchId);
      }
    }
  }
  return { admits, may };
}

function assertFacts(
  db: Database,
  inputs: FlowInputs,
  admissions: Admissions,
  request: FlowRequest,
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

  for (const answered of inputs.edges.answers.values()) {
    db.add("answers", [answered.router, answered.matchId]);
  }

  for (const matchId of admissions.admits) {
    db.add("admits", [matchId]);
  }

  for (const matchId of admissions.may) {
    db.add("mayAdmit", [matchId]);
  }

  for (const claim of inputs.claims) {
    const outcome = servesRequest(claim.binding, request.method, request.path);
    if (outcome === null || outcome === "nomatch") {
      continue;
    }

    for (const unit of claim.units) {
      db.add("serves", [unit, claim.ref]);
    }

    db.add(outcome === "match" ? "admitsServe" : "mayServe", [claim.ref]);
  }
}

function targetsOf(db: Database, relation: string, entry: string): Set<string> {
  const found = new Set<string>();
  for (const tuple of db.lookup(relation, 0, entry)) {
    found.add(String(tuple[1]));
  }
  return found;
}

function endpointSets(
  certain: Set<string>,
  may: Set<string>,
): FlowEndpointSets {
  const possible = [...may].filter((name) => !certain.has(name));
  return { certain: [...certain].sort(), possible: possible.sort() };
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
  const db = new Database();
  assertFacts(db, inputs, admissions, request);
  evaluate(db, FLOW_RULES);

  return {
    from(entry: string): FlowView {
      const certainNodes = targetsOf(db, "reaches", entry);
      const mayNodes = targetsOf(db, "mayReach", entry);
      const isUnit = (name: string): boolean => inputs.units.has(name);

      const certainAnswers = targetsOf(db, "reachesAnswer", entry);
      const mayAnswers = targetsOf(db, "mayReachAnswer", entry);
      const answered = (matchId: string): AnsweredMatch =>
        inputs.edges.answers.get(matchId) ?? { matchId, router: entry };

      return {
        nodes: endpointSets(certainNodes, mayNodes),
        units: endpointSets(
          new Set([...certainNodes].filter(isUnit)),
          new Set([...mayNodes].filter(isUnit)),
        ),
        answers: {
          certain: [...certainAnswers].sort().map(answered),
          possible: [...mayAnswers]
            .filter((matchId) => !certainAnswers.has(matchId))
            .sort()
            .map(answered),
        },
        claims: endpointSets(
          targetsOf(db, "servedBy", entry),
          targetsOf(db, "mayServedBy", entry),
        ),
      };
    },
  };
}
