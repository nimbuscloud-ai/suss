/**
 * Would this consumer path misread a response the provider sends?
 *
 * A path that reads a field off the response body, on a response whose
 * body does not include that field, gets undefined back and no error
 * says so. That is the outcome this check reports, and it fires only
 * when nothing on the path tells that response apart from one whose
 * body includes the field. The README beside this file says what
 * counts as telling responses apart and why each rule is so narrow.
 *
 * The provider's responses are its extracted transitions; in a pair
 * against an OpenAPI or ts-rest document those are the declared
 * responses.
 */

import {
  bodyAccessorsFor,
  statusAccessorsFor,
  successAccessorsFor,
  unwrapBodyField,
} from "../contract/declaredContract.js";
import {
  bodyFieldsConsumerTests,
  failureOnlyBodyFields,
} from "./contentDiscrimination.js";
import {
  extractResponseStatus,
  extractResponseStatusRange,
  isSuccessStatus,
  makeBoundary,
  makeSide,
} from "./responseMatch.js";
import { branchHandlesStatus, guardsForBranch } from "./statusRanges.js";

import type {
  BehavioralSummary,
  Finding,
  Predicate,
  Transition,
  TypeShape,
  ValueRef,
} from "@suss/behavioral-ir";

/**
 * One response with a body. A literal status spans `[status, status]`,
 * "4XX" spans its whole class, and the label is how a finding says which.
 */
interface ProviderResponse {
  min: number;
  max: number;
  label: string;
  body: TypeShape;
  transitionId: string;
}

function providerResponses(provider: BehavioralSummary): ProviderResponse[] {
  const out: ProviderResponse[] = [];
  for (const t of provider.transitions) {
    if (t.output.type !== "response" || t.output.body === null) {
      continue;
    }
    const status = extractResponseStatus(t);
    if (status !== null) {
      out.push({
        min: status,
        max: status,
        label: String(status),
        body: t.output.body,
        transitionId: t.id,
      });
      continue;
    }
    const range = extractResponseStatusRange(t);
    if (range !== null) {
      out.push({
        min: range.min,
        max: range.max,
        label: range.spec,
        body: t.output.body,
        transitionId: t.id,
      });
    }
  }
  return out;
}

/** Statuses both spans admit exist. */
function spansIntersect(
  a: { min: number; max: number },
  b: { min: number; max: number },
): boolean {
  return a.min <= b.max && a.max >= b.min;
}

/** The property name a reference reads last, or null for anything else. */
function outermostField(ref: ValueRef): string | null {
  if (ref.type === "derived") {
    if (ref.derivation.type === "destructured") {
      return ref.derivation.field;
    }
    if (ref.derivation.type === "propertyAccess") {
      return ref.derivation.property;
    }
    return null;
  }
  if (ref.type === "input") {
    return ref.path[ref.path.length - 1] ?? null;
  }
  if (ref.type === "dependency") {
    return ref.accessChain[ref.accessChain.length - 1] ?? null;
  }
  return null;
}

/**
 * Body fields this branch's guards require to be present for the
 * branch to run at all. `if (!res.ok && res.error)` never runs on a
 * response whose body has no error to be truthy, so that response is
 * not one this branch can misread. Only tests that are always true on
 * the branch count: positive truthiness, an equality, and the operands
 * of an `and`.
 */
function requiredBodyFields(
  conditions: readonly Predicate[],
  skip: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  const visit = (p: Predicate): void => {
    if (p.type === "truthinessCheck" && !p.negated) {
      const field = outermostField(p.subject);
      if (field !== null && !skip.has(field)) {
        out.add(field);
      }
      return;
    }
    if (p.type === "comparison" && p.op === "eq") {
      for (const side of [p.left, p.right]) {
        const field = outermostField(side);
        if (field !== null && !skip.has(field)) {
          out.add(field);
        }
      }
      return;
    }
    if (p.type === "compound" && p.op === "and") {
      for (const operand of p.operands) {
        visit(operand);
      }
    }
  };
  for (const condition of conditions) {
    visit(condition);
  }
  return out;
}

/** Whether a body may carry `field`; anything unreadable may. */
function carriesField(shape: TypeShape, field: string): boolean {
  if (shape.type === "record") {
    if (shape.properties[field] !== undefined) {
      return true;
    }
    return (shape.spreads?.length ?? 0) > 0;
  }
  if (shape.type === "union") {
    return shape.variants.some((v) => carriesField(v, field));
  }
  return true;
}

/** Whether a body provably has no `field`: a closed record without it. */
function fieldAbsent(shape: TypeShape, field: string): boolean {
  if (shape.type === "record") {
    if (shape.properties[field] !== undefined) {
      return false;
    }
    return (shape.spreads?.length ?? 0) === 0;
  }
  if (shape.type === "union") {
    return shape.variants.every((v) => fieldAbsent(v, field));
  }
  return false;
}

/**
 * Which statuses this branch runs on: the same reading provider
 * coverage uses, so the two checks agree on where a branch applies.
 */
function branchAdmitsStatus(
  ct: Transition,
  status: number,
  statusAccessors: ReadonlySet<string>,
  successAccessors: ReadonlySet<string>,
): boolean {
  if (ct.isDefault && isSuccessStatus(status)) {
    return true;
  }
  return branchHandlesStatus(
    ct.conditions,
    guardsForBranch(ct, statusAccessors, successAccessors),
    status,
  );
}

/** Whether the branch runs on any status the response's span admits. */
function branchAdmitsResponse(
  ct: Transition,
  r: ProviderResponse,
  statusAccessors: ReadonlySet<string>,
  successAccessors: ReadonlySet<string>,
): boolean {
  for (let status = r.min; status <= r.max; status++) {
    if (branchAdmitsStatus(ct, status, statusAccessors, successAccessors)) {
      return true;
    }
  }
  return false;
}

function pathNoun(ct: Transition): string {
  return ct.isDefault
    ? "The consumer's fall-through path"
    : "This consumer branch";
}

function describeMisread(
  ct: Transition,
  field: string,
  label: string,
  carrier: string | null,
): string {
  const opening = `${pathNoun(ct)} reads "${field}", but the ${label} body the provider sends does not include it`;
  if (carrier === null) {
    return `${opening}, and neither does any other response. The read comes back undefined and no error says so.`;
  }
  return `${opening}, and nothing on the path tells the ${label} apart from the ${carrier} whose body does include it. On a ${label} the read comes back undefined and no error says so.`;
}

export function checkResponseMisread(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  const responses = providerResponses(provider);
  if (responses.length === 0) {
    return [];
  }

  const findings: Finding[] = [];
  const boundary = makeBoundary(provider, consumer);
  const statusAccessors = statusAccessorsFor(consumer);
  const successAccessors = successAccessorsFor(consumer);
  const accessors = new Set(bodyAccessorsFor(consumer));
  const tested = bodyFieldsConsumerTests(consumer);
  const failureOnly = new Set(
    failureOnlyBodyFields(provider).flatMap((entry) => [...entry.fields]),
  );
  const guardSkip = new Set([
    ...statusAccessors,
    ...successAccessors,
    ...accessors,
  ]);

  for (const ct of consumer.transitions) {
    const expectedInput = ct.expectedInput;
    if (expectedInput === undefined || expectedInput === null) {
      continue;
    }
    const shape = unwrapBodyField(expectedInput, consumer);
    if (shape.type !== "record") {
      continue;
    }
    const reads = Object.keys(shape.properties).filter(
      (field) => !tested.has(field) && !accessors.has(field),
    );
    if (reads.length === 0) {
      continue;
    }

    const required = requiredBodyFields(ct.conditions, guardSkip);
    const admitted = responses.filter(
      (r) =>
        branchAdmitsResponse(ct, r, statusAccessors, successAccessors) &&
        [...required].every((field) => carriesField(r.body, field)),
    );

    const bySpan = new Map<string, ProviderResponse[]>();
    for (const r of admitted) {
      const key = `${r.min}:${r.max}`;
      bySpan.set(key, [...(bySpan.get(key) ?? []), r]);
    }
    // Narrowest span first, so an arrival is claimed once, under the
    // most specific label ("404" before "4XX").
    const groups = [...bySpan.values()].sort(
      (a, b) => a[0].max - a[0].min - (b[0].max - b[0].min),
    );

    const claimed = new Map<string, ProviderResponse[]>();
    for (const group of groups) {
      const span = group[0];
      // The absence proof takes in every response the same status may
      // arrive with: a declared 404 and a declared 4XX alike.
      const arrivals = responses.filter((r) => spansIntersect(r, span));
      // A field a failure body marks the case with is not a claim
      // about the 2xx; the coverage README says why.
      const success = span.min >= 200 && span.max < 300;
      const claims = success
        ? reads.filter((field) => !failureOnly.has(field))
        : reads;
      for (const field of claims) {
        if (!arrivals.every((r) => fieldAbsent(r.body, field))) {
          continue;
        }
        const already = claimed.get(field) ?? [];
        if (already.some((prior) => spansIntersect(prior, span))) {
          continue;
        }
        const carrier =
          responses.find(
            (r) => !spansIntersect(r, span) && carriesField(r.body, field),
          )?.label ?? null;
        claimed.set(field, [...already, span]);
        findings.push({
          kind: "misreadProviderResponse",
          aspect: "read",
          boundary,
          provider: makeSide(provider, group[0].transitionId),
          consumer: makeSide(consumer, ct.id),
          // The path runs on an input the provider produces and reads a
          // value that is not there, which is the error sentence (#471).
          description: describeMisread(ct, field, span.label, carrier),
          severity: "error",
        });
      }
    }
  }

  return findings;
}
