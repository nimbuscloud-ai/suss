/**
 * The interface between a manifest reader's routing edges and the
 * reachability pass that walks them.
 *
 * A routing edge's match record keeps its conditions as data, in the
 * condition language given by `matchLanguage` on the routing metadata.
 * That language determines which match a router picks for a request.
 * The reader defines how priorities order matches and how patterns
 * glob, and the generic walk has no rules of its own for either. So a
 * reader that emits edges also exports a `RouterMatchSelector` for its
 * language, and the walk passes each router's match records to the
 * selector for their language through a table keyed by these types.
 */

import type { RoutingMetadata } from "./metadata.js";

export interface FlowRequest {
  /** Uppercase HTTP method ("GET"). */
  method: string;
  /** Request host ("shop.example.com"), or null when the question does not say. */
  host: string | null;
  /** Absolute request path ("/api/orders/123"). */
  path: string;
}

export type RoutingMatchCondition = NonNullable<
  RoutingMetadata["conditions"]
>[number];

/** When a forward is weighted across targets, all its edges share one record. */
export interface RoutingMatchRecord {
  matchId: string;
  /** Absent for a router's default action. */
  priority?: number;
  conditions: RoutingMatchCondition[];
}

/**
 * `possible` lists the matches that could take the request, depending
 * on something the declarations leave open until run time. A match in
 * neither list rejects the request.
 */
export interface RouterSelection {
  admitted: string[];
  possible: string[];
}

/** Implemented by the reader that defines the router's condition language. */
export type RouterMatchSelector = (
  records: RoutingMatchRecord[],
  request: FlowRequest,
) => RouterSelection;

export function nestedDocumentLabel(
  rootLabel: string,
  stackPath: string[],
): string {
  return stackPath.length === 0
    ? rootLabel
    : `${rootLabel}#${stackPath.join("/")}`;
}

export function rootDocumentLabel(label: string): string {
  const marker = label.indexOf("#");
  if (marker === -1) {
    return label;
  }

  return label.slice(0, marker);
}

export interface DocumentLabelParts {
  /** The reader that wrote the label, such as `cloudformation`. */
  reader: string;
  location: string;
}

/** The `(?!:)` stops the `::` in a summary ref from matching as a label. */
const READER_LABEL = /^([a-z][a-z0-9-]*):(?!:)(.+)$/;

export function parseDocumentLabel(label: string): DocumentLabelParts | null {
  const match = READER_LABEL.exec(label);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }

  return { reader: match[1], location: match[2] };
}

export function namesDocumentByFileName(label: string): boolean {
  const parts = parseDocumentLabel(label);
  return parts !== null && !parts.location.includes("/");
}
