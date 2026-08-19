/**
 * Which statuses a consumer tells apart by what came back in the body
 * rather than by the status code.
 *
 * `if (res.error) toast.error(res.error)` handles the 404 the provider
 * sends with `{ error }` on it, because a 200 from that provider has no
 * `error` to find. The README beside this file says why the field has to
 * be one only a failure body includes.
 */

import { bodyAccessorsFor, unwrapBodyField } from "../contract/declaredContract.js";
import { extractResponseStatus, isSuccessStatus } from "./responseMatch.js";

import type {
  BehavioralSummary,
  Predicate,
  TypeShape,
  ValueRef,
} from "@suss/behavioral-ir";

/** The keys a record shape declares, reaching through an optional wrapper. */
function topLevelFields(shape: TypeShape | null): Set<string> {
  if (shape === null) {
    return new Set();
  }
  if (shape.type === "union") {
    const out = new Set<string>();
    for (const variant of shape.variants) {
      for (const key of topLevelFields(variant)) {
        out.add(key);
      }
    }
    return out;
  }
  return shape.type === "record" ? new Set(Object.keys(shape.properties)) : new Set();
}

function bodyFieldsOf(summary: BehavioralSummary, status: number): Set<string> {
  const out = new Set<string>();
  for (const t of summary.transitions) {
    if (t.output.type !== "response" || extractResponseStatus(t) !== status) {
      continue;
    }
    for (const key of topLevelFields(t.output.body)) {
      out.add(key);
    }
  }
  return out;
}

/**
 * Per status, the body fields the provider sends on it and on no 2xx.
 * A field both halves include tells the two apart for nobody.
 */
export function failureOnlyBodyFields(
  provider: BehavioralSummary,
): Map<number, Set<string>> {
  const successFields = new Set<string>();
  const failureStatuses = new Set<number>();
  for (const t of provider.transitions) {
    const status = extractResponseStatus(t);
    if (status === null) {
      continue;
    }
    if (isSuccessStatus(status)) {
      for (const key of topLevelFields(t.output.type === "response" ? t.output.body : null)) {
        successFields.add(key);
      }
      continue;
    }
    failureStatuses.add(status);
  }

  const out = new Map<number, Set<string>>();
  for (const status of failureStatuses) {
    const own = new Set(
      [...bodyFieldsOf(provider, status)].filter((f) => !successFields.has(f)),
    );
    out.set(status, own);
  }
  return out;
}

/** Every property name a value reference reads on its way to a value. */
function fieldsInRef(ref: ValueRef, out: Set<string>): void {
  if (ref.type === "derived") {
    if (ref.derivation.type === "propertyAccess") {
      out.add(ref.derivation.property);
    }
    if (ref.derivation.type === "destructured") {
      out.add(ref.derivation.field);
    }
    fieldsInRef(ref.from, out);
    return;
  }
  if (ref.type === "input") {
    for (const step of ref.path) {
      out.add(step);
    }
    return;
  }
  if (ref.type === "dependency") {
    for (const step of ref.accessChain) {
      out.add(step);
    }
  }
}

function fieldsInPredicate(pred: Predicate, out: Set<string>): void {
  if (pred.type === "comparison") {
    fieldsInRef(pred.left, out);
    fieldsInRef(pred.right, out);
    return;
  }
  if (pred.type === "truthinessCheck") {
    fieldsInRef(pred.subject, out);
    return;
  }
  if (pred.type === "negation") {
    fieldsInPredicate(pred.operand, out);
    return;
  }
  if (pred.type === "compound") {
    for (const operand of pred.operands) {
      fieldsInPredicate(operand, out);
    }
  }
}

/**
 * Body fields the consumer looked at: the ones it reads off a response
 * and the ones it tests in a guard. Reading and testing are the same
 * evidence here, because a field a consumer never mentions cannot be
 * how it told two cases apart.
 */
export function bodyFieldsConsumerReads(
  consumer: BehavioralSummary,
): Set<string> {
  const out = new Set<string>();
  const accessors = new Set(bodyAccessorsFor(consumer));
  for (const t of consumer.transitions) {
    if (t.expectedInput != null) {
      for (const key of topLevelFields(unwrapBodyField(t.expectedInput, consumer))) {
        out.add(key);
      }
    }
    for (const condition of t.conditions) {
      fieldsInPredicate(condition, out);
    }
  }
  // The wrapper a client returns the body in is not a body field.
  for (const accessor of accessors) {
    out.delete(accessor);
  }
  return out;
}

/**
 * Whether the consumer tells `status` apart by content: it mentions a
 * body field the provider sends on that status and on no 2xx.
 */
export function consumerDiscriminatesByContent(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): (status: number) => boolean {
  const failureFields = failureOnlyBodyFields(provider);
  const read = bodyFieldsConsumerReads(consumer);
  return (status) => {
    const own = failureFields.get(status);
    return own !== undefined && [...own].some((field) => read.has(field));
  };
}
