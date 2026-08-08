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

/**
 * The label a nested document's summaries carry: the root document's
 * own label, then the stack path that reaches this document. A logical
 * id is unique inside one document and nowhere else, so the label is
 * what tells two documents' resources apart, and the reachability walk
 * scopes its nodes by the root part: one source template family, one
 * scope, however many nested documents it embeds.
 *
 * The convention lives here, beside the routing contract, so a reader
 * composing labels and the walk decomposing them cannot drift apart.
 */
export function nestedDocumentLabel(
  rootLabel: string,
  stackPath: string[],
): string {
  return stackPath.length === 0
    ? rootLabel
    : `${rootLabel}#${stackPath.join("/")}`;
}

/**
 * The root label a document label was composed from: everything before
 * the first stack-path marker, or the whole label for a root document.
 */
export function rootDocumentLabel(label: string): string {
  const marker = label.indexOf("#");
  if (marker === -1) {
    return label;
  }

  return label.slice(0, marker);
}

/** A document label pulled apart into who wrote it and what it names. */
export interface DocumentLabelParts {
  /** The reader that wrote the label, such as `cloudformation`. */
  reader: string;
  /** Where the document sits, as that reader recorded it. */
  location: string;
}

/**
 * A reader's document label read back: the reader's name, a colon, and
 * where the document sits. Null for anything that is not one.
 *
 * The `(?!:)` keeps the `::` of a summary ref out, so a name pointing at
 * source code never reads as a document label.
 */
const READER_LABEL = /^([a-z][a-z0-9-]*):(?!:)(.+)$/;

/** The reader and location a document label was composed from, or null. */
export function parseDocumentLabel(label: string): DocumentLabelParts | null {
  const match = READER_LABEL.exec(label);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }

  return { reader: match[1], location: match[2] };
}

/**
 * Does this label name a document by file name alone, with no path?
 * Readers used to label documents that way, so `cloudformation:template.yaml`
 * named every template.yaml a run read at once.
 */
export function namesDocumentByFileName(label: string): boolean {
  const parts = parseDocumentLabel(label);
  return parts !== null && !parts.location.includes("/");
}
