// declared-contract.ts — shared helpers for reading the HTTP-scoped
// metadata a summary may carry: the declared response contract, the
// body accessors a consumer uses (axios `.data`, fetch `.body`), and
// the status-code accessors it uses (almost always `.status` today).
//
// All three live under `metadata.http.*` so the namespace is explicitly
// HTTP-scoped; a future GraphQL / Lambda-invoke / queue pack would use
// its own sibling namespace (`metadata.graphql`, `metadata.lambda`, …).
// See `docs/boundary-semantics.md`.

import type { BehavioralSummary, TypeShape } from "@suss/behavioral-ir";

export interface DeclaredContract {
  responses: Array<{ statusCode: number; body: TypeShape | null }>;
}

function httpMetadata(
  summary: BehavioralSummary,
): Record<string, unknown> | undefined {
  const http = summary.metadata?.http;
  return http && typeof http === "object"
    ? (http as Record<string, unknown>)
    : undefined;
}

export function readDeclaredContract(
  summary: BehavioralSummary,
): DeclaredContract | null {
  const raw = httpMetadata(summary)?.declaredContract;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const responses = (raw as { responses?: unknown }).responses;
  if (!Array.isArray(responses)) {
    return null;
  }
  const validated: Array<{ statusCode: number; body: TypeShape | null }> = [];
  for (const r of responses) {
    if (
      r &&
      typeof r === "object" &&
      typeof (r as { statusCode?: unknown }).statusCode === "number"
    ) {
      const bodyRaw = (r as { body?: unknown }).body;
      const body =
        bodyRaw && typeof bodyRaw === "object" ? (bodyRaw as TypeShape) : null;
      validated.push({
        statusCode: (r as { statusCode: number }).statusCode,
        body,
      });
    }
  }
  return { responses: validated };
}

export function bodyAccessorsFor(consumer: BehavioralSummary): string[] {
  const fromMetadata = httpMetadata(consumer)?.bodyAccessors;
  if (Array.isArray(fromMetadata) && fromMetadata.length > 0) {
    return fromMetadata.filter((v): v is string => typeof v === "string");
  }
  // Fallback for summaries produced before bodyAccessors metadata existed
  // (or written by hand) — assume the historical fetch wrapper.
  return ["body"];
}

/**
 * Names of properties that a consumer summary uses to read the HTTP
 * status code from a response. Adapter writes these from the pack's
 * `responseSemantics`; falls back to the historical names for
 * hand-written summaries or summaries produced before this metadata
 * existed.
 */
export function statusAccessorsFor(
  summary: BehavioralSummary,
): ReadonlySet<string> {
  const fromMetadata = httpMetadata(summary)?.statusAccessors;
  if (Array.isArray(fromMetadata) && fromMetadata.length > 0) {
    return new Set(
      fromMetadata.filter((v): v is string => typeof v === "string"),
    );
  }
  return new Set(["status", "statusCode"]);
}
