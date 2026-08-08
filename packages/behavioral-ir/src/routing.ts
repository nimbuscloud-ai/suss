/**
 * The contract between a manifest reader's routing edges and the
 * reachability pass that walks them.
 *
 * A routing edge's match record keeps its conditions as data, written
 * in the condition language the reader named (`matchLanguage` on the
 * routing metadata). Which match a router hands a request to is up to
 * that language: the ordering its priorities declare and the globbing
 * its patterns use belong to the reader that owns the vocabulary, never
 * to the generic walk. So a reader that emits edges also exports a
 * `RouterMatchSelector` for its language, and the walk sends each
 * router's match records to the selector for their language through a
 * table keyed by the types here.
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
 * `possible` lists the matches that could take the request once something
 * the declarations leave open gets decided at runtime. A match in neither
 * list refuses the request.
 */
export interface RouterSelection {
  admitted: string[];
  possible: string[];
}

/** Implemented by whichever reader owns the router's condition language. */
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
