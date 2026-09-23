/**
 * Reads the HTTP metadata a summary may have: the declared response
 * contract, the property a consumer reads the body from (axios `.data`,
 * fetch `.body`), and the properties it reads the status from.
 *
 * All of it lives under `metadata.http`. Other protocols keep theirs in
 * their own namespace, such as `metadata.graphql`.
 */

import { readHttpMetadata } from "@suss/behavioral-ir";

import type { BehavioralSummary, TypeShape } from "@suss/behavioral-ir";

export type ContractProvenance = "derived" | "independent";

export interface DeclaredContract {
  responses: Array<{ statusCode: number; body: TypeShape | null }>;
  /**
   * Responses declared by class ("4XX"): the source promises some
   * status between `min` and `max` without saying which, so a consumer
   * branch on any member agrees with the contract.
   */
  responseRanges: Array<{
    min: number;
    max: number;
    spec: string;
    body: TypeShape | null;
  }>;
  /**
   * The catch-all for every status the entries above leave out, the way
   * OpenAPI's `default` is, or null when the source declares none. With
   * one present, a consumer status is never undeclared.
   */
  defaultResponse: { body: TypeShape | null } | null;
  /**
   * "derived" means the contract comes from the same source as this
   * summary's `transitions`, as with an OpenAPI stub, where both come
   * from one operation's `responses` block. Comparing the two would
   * prove nothing, so `checkContractConsistency` skips them.
   *
   * "independent" means the contract is a separate statement, such as a
   * ts-rest router declaration beside the handler code, so comparing
   * the two can find something.
   *
   * A pack that does not say gets "independent", because a spurious
   * finding costs less than a missed one.
   */
  provenance: ContractProvenance;
  /** The framework the producing pack recorded. */
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
    responseRanges: (raw.responseRanges ?? []).map((r) => ({
      min: r.min,
      max: r.max,
      spec: r.spec,
      body: r.body ?? null,
    })),
    defaultResponse:
      raw.defaultResponse === undefined
        ? null
        : { body: raw.defaultResponse.body ?? null },
  };
}

/**
 * Whether a contract declares `status`: as a literal, inside a range,
 * or through the catch-all default, which covers every status the
 * other entries leave out.
 */
export function contractDeclaresStatus(
  contract: DeclaredContract,
  status: number,
): boolean {
  if (contract.defaultResponse !== null) {
    return true;
  }
  if (contract.responses.some((r) => r.statusCode === status)) {
    return true;
  }
  return contract.responseRanges.some(
    (r) => status >= r.min && status <= r.max,
  );
}

export function bodyAccessorsFor(consumer: BehavioralSummary): string[] {
  const fromMetadata = readHttpMetadata(consumer)?.bodyAccessors;
  if (fromMetadata !== undefined && fromMetadata.length > 0) {
    return fromMetadata;
  }
  // A hand-written summary, or one from before packs recorded body
  // accessors, gets the fetch wrapper's `body`.
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
 * The properties a consumer reads the HTTP status from. The adapter
 * records them from the pack's `responseSemantics`. A hand-written
 * summary, or an older one without them, gets `status` and
 * `statusCode`.
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
 * The properties a consumer reads to learn whether a response
 * succeeded, as opposed to which status it had. `fetch` calls it `ok`,
 * and a consumer guarding on it handles the whole 2xx class. These are
 * kept apart from the status accessors because only a status accessor
 * compares against a number.
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
