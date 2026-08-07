// routing.ts: the contract between a manifest reader's routing edges
// and the reachability pass that walks them.
//
// A routing edge's match record carries its conditions as data, in the
// condition language the reader named (`matchLanguage` on the routing
// metadata). Deciding which match a router hands a request to is that
// language's business: the ordering its priorities declare and the
// globbing its patterns use both belong to the reader that owns the
// vocabulary, never to the generic walk. So a reader that emits edges
// also exports a `RouterMatchSelector` for its language, and the walk
// dispatches each router's match records to the selector for their
// language through a table keyed by these types.

import type { RoutingMetadata } from "./metadata.js";

/** The request a flow question asks about. */
export interface FlowRequest {
  /** Uppercase HTTP method ("GET"). */
  method: string;
  /** Request host ("shop.example.com"), or null when the question names none. */
  host: string | null;
  /** Absolute request path ("/api/orders/123"). */
  path: string;
}

export type RoutingMatchCondition = NonNullable<
  RoutingMetadata["conditions"]
>[number];

/**
 * One match a router declares: a rule, or the router's own default
 * action. A weighted forward's several edges share one record; the
 * match admits the request, and which target then carries it is the
 * edges' business, not the selector's.
 */
export interface RoutingMatchRecord {
  matchId: string;
  /** The match's declared ordering rank. Absent for a default action. What the ordering means is the selector's business. */
  priority?: number;
  conditions: RoutingMatchCondition[];
}

/**
 * What a router does with a request, as far as its declarations can
 * say. `admitted` names the match that takes the request outright.
 * `possible` names every match that could take it once a condition
 * the selector does not evaluate, or an ordering the declarations do
 * not settle, is decided at runtime. A match in neither list refuses
 * the request.
 */
export interface RouterSelection {
  admitted: string[];
  possible: string[];
}

/**
 * One condition language's selection: given every match one router
 * declares and a request, say which match takes it. Implemented by
 * the reader that owns the language and dispatched through a table
 * keyed by `matchLanguage`.
 */
export type RouterMatchSelector = (
  records: RoutingMatchRecord[],
  request: FlowRequest,
) => RouterSelection;
