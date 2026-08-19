// declared-contract.ts: shared helpers for reading the HTTP-scoped
// metadata a summary may carry: the declared response contract, the
// body accessors a consumer uses (axios `.data`, fetch `.body`), and
// the status-code accessors it uses (almost always `.status` today).
//
// All three live under `metadata.http.*` so the namespace is explicitly
// HTTP-scoped; a future GraphQL / Lambda-invoke / queue pack would use
// its own sibling namespace (`metadata.graphql`, `metadata.lambda`, …).
// See `docs/boundary-semantics.md`.

import { readHttpMetadata } from "@suss/behavioral-ir";

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
   * Defaults to "independent" when a pack doesn't explicitly say; we'd
   * rather investigate a spurious finding than silently drop one that
   * mattered.
   */
  provenance: ContractProvenance;
  /** Framework tag recorded by the producing pack (passed through). */
  framework?: string;
}

/**
 * The declared contract for a summary, normalized so `body` always
 * comes back `TypeShape | null` (never `undefined`) for callers that
 * compare it directly against a produced body shape.
 */
export function readDeclaredContract(
  summary: BehavioralSummary,
): DeclaredContract | null {
  const raw = readHttpMetadata(summary)?.declaredContract;
  if (raw === undefined) {
    return null;
  }
  return {
    ...(raw.framework !== undefined ? { framework: raw.framework } : {}),
    provenance: raw.provenance,
    responses: raw.responses.map((r) => ({
      statusCode: r.statusCode,
      body: r.body ?? null,
    })),
  };
}

export function bodyAccessorsFor(consumer: BehavioralSummary): string[] {
  const fromMetadata = readHttpMetadata(consumer)?.bodyAccessors;
  if (fromMetadata !== undefined && fromMetadata.length > 0) {
    return fromMetadata;
  }
  // Fallback for summaries produced before bodyAccessors metadata existed
  // (or written by hand): assume the historical fetch wrapper.
  return ["body"];
}

/**
 * Reach past the envelope a consumer wraps its response body in, so a
 * shape read off the consumer compares against the shape the provider
 * returns rather than against the client library's wrapper.
 *
 * A shape with none of the consumer's accessors on it is already the
 * body, so it comes back untouched.
 */
export function unwrapBodyField(
  shape: TypeShape,
  consumer: BehavioralSummary,
): TypeShape {
  if (shape.type !== "record") {
    return shape;
  }
  for (const accessor of bodyAccessorsFor(consumer)) {
    const wrapped = shape.properties[accessor];
    if (wrapped !== undefined) {
      return wrapped;
    }
  }
  return shape;
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
  const fromMetadata = readHttpMetadata(summary)?.statusAccessors;
  if (fromMetadata !== undefined && fromMetadata.length > 0) {
    return new Set(fromMetadata);
  }
  return new Set(["status", "statusCode"]);
}

/**
 * Names of properties a consumer summary uses to ask whether a response
 * succeeded, rather than which status it returned. `fetch` calls it `ok`,
 * and a consumer guarding on it handles the whole 2xx class. Kept apart
 * from the status accessors because the two answer different questions
 * and only one of them compares against a number.
 */
export function successAccessorsFor(
  summary: BehavioralSummary,
): ReadonlySet<string> {
  const fromMetadata = readHttpMetadata(summary)?.successAccessors;
  if (fromMetadata !== undefined && fromMetadata.length > 0) {
    return new Set(fromMetadata);
  }
  return new Set(["ok"]);
}

/**
 * How this consumer's client hands back a response the server refused.
 * On `"exception"` there is no status for a guard to read, so the
 * consumer's `catch` is the branch every failure arrives on.
 */
export function failureDeliveryFor(
  summary: BehavioralSummary,
): "response" | "exception" {
  return readHttpMetadata(summary)?.failureDelivery ?? "response";
}
