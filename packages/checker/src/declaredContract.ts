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

export type ContractProvenance = "derived" | "independent";

export interface DeclaredContract {
  responses: Array<{ statusCode: number; body: TypeShape | null }>;
  /**
   * "derived": the contract is extracted from the same source that
   *   drives this summary's `transitions[]` (e.g. an OpenAPI stub's
   *   contract and its transitions both come from the same operation's
   *   `responses` block). Self-comparison via checkContractConsistency
   *   would be tautological and is skipped.
   *
   * "independent": the contract is a separate statement from the
   *   transitions (ts-rest router declaration vs handler code, CFN
   *   MethodResponses vs integration-derived transitions, etc.).
   *   Contract-consistency comparison is meaningful.
   *
   * Defaults to "independent" when a pack doesn't explicitly say —
   * we'd rather investigate a spurious finding than silently drop a
   * real one.
   */
  provenance: ContractProvenance;
  /** Framework tag recorded by the producing pack (passed through). */
  framework?: string;
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
  const provRaw = (raw as { provenance?: unknown }).provenance;
  const provenance: ContractProvenance =
    provRaw === "derived" ? "derived" : "independent";
  const framework =
    typeof (raw as { framework?: unknown }).framework === "string"
      ? (raw as { framework: string }).framework
      : undefined;
  return {
    responses: validated,
    provenance,
    ...(framework !== undefined ? { framework } : {}),
  };
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
