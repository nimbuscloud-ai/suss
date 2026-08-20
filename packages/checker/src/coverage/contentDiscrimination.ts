/**
 * Which statuses a consumer tells apart by what came back in the body
 * rather than by the status code.
 *
 * `if (res.error) toast.error(res.error)` handles the 404 the provider
 * sends with `{ error }` on it, because a 200 from that provider has no
 * `error` to find. The README beside this file says why the field has to
 * be one only a failure body includes.
 */

import {
  bodyAccessorsFor,
  statusAccessorsFor,
  successAccessorsFor,
  unwrapBodyField,
} from "../contract/declaredContract.js";
import {
  extractResponseStatus,
  extractResponseStatusRange,
} from "./responseMatch.js";

import type {
  BehavioralSummary,
  Predicate,
  Transition,
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

/** The statuses one failure response covers and the fields only it sends. */
export interface FailureBodyFields {
  min: number;
  max: number;
  fields: Set<string>;
}

/** The statuses a response transition covers: one for a literal, more for a range. */
function responseStatusSpan(
  t: Transition,
): { min: number; max: number } | null {
  const status = extractResponseStatus(t);
  if (status !== null) {
    return { min: status, max: status };
  }
  return extractResponseStatusRange(t);
}

/**
 * Per failure response, the body fields the provider sends on it and on
 * no 2xx. A field both halves include tells the two apart for nobody.
 * A response declared as a range ("4XX") counts for every status in it.
 */
export function failureOnlyBodyFields(
  provider: BehavioralSummary,
): FailureBodyFields[] {
  const successFields = new Set<string>();
  const failureEntries: FailureBodyFields[] = [];
  for (const t of provider.transitions) {
    if (t.output.type !== "response") {
      continue;
    }
    const span = responseStatusSpan(t);
    if (span === null) {
      continue;
    }
    const fields = topLevelFields(t.output.body);
    if (span.min >= 200 && span.max < 300) {
      for (const key of fields) {
        successFields.add(key);
      }
      continue;
    }
    failureEntries.push({ min: span.min, max: span.max, fields });
  }

  return failureEntries.map((entry) => ({
    ...entry,
    fields: new Set([...entry.fields].filter((f) => !successFields.has(f))),
  }));
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
 * The body fields the consumer's guards test, on any of its branches.
 * A tested field is how the consumer tells cases apart, so its absence
 * from a body is an answer rather than a misread. Collected across the
 * whole consumer because the extractor attributes a read inside a
 * callback to every path through it.
 */
export function bodyFieldsConsumerTests(
  consumer: BehavioralSummary,
): Set<string> {
  const out = new Set<string>();
  for (const t of consumer.transitions) {
    for (const condition of t.conditions) {
      fieldsInPredicate(condition, out);
    }
  }
  for (const name of [
    ...statusAccessorsFor(consumer),
    ...successAccessorsFor(consumer),
    ...bodyAccessorsFor(consumer),
  ]) {
    out.delete(name);
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
  return (status) =>
    failureFields.some(
      (entry) =>
        status >= entry.min &&
        status <= entry.max &&
        [...entry.fields].some((field) => read.has(field)),
    );
}
