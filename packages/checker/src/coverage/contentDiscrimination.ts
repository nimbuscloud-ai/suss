/**
 * Which statuses a consumer tells apart by what came back in the body
 * rather than by the status code.
 *
 * `if (res.error) toast.error(res.error)` handles the 404 the provider
 * sends with `{ error }` on it, because a 200 from that provider has no
 * `error` to find. The mirror case counts too: the `else` of
 * `if (data.exists)` handles a 400 whose body has no `exists`. The
 * README beside this file says what each body has to send for a field
 * to tell the two apart.
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
  type StatusAccessors,
} from "./responseMatch.js";
import {
  branchHandlesStatus,
  branchStatusRanges,
  guardsForBranch,
} from "./statusRanges.js";

import type {
  BehavioralSummary,
  Predicate,
  Transition,
  TypeShape,
  ValueRef,
} from "@suss/behavioral-ir";

/** The keys a record declares, merged across the variants of a union. */
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
 * Per failure response, the body fields the provider sends on it and
 * never on a 2xx. A field that both kinds of body include cannot tell
 * them apart. A response declared as a range ("4XX") counts for every
 * status in it.
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
 * A tested field is how the consumer tells cases apart, so finding it
 * missing from a body is expected and does not count as a misread. The
 * fields are collected across the whole consumer because the extractor
 * attributes a read inside a callback to every path through it.
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
    ...statusAccessorsFor(consumer).members,
    ...successAccessorsFor(consumer).members,
    ...bodyAccessorsFor(consumer),
  ]) {
    out.delete(name);
  }
  return out;
}

/**
 * Whether the consumer tells `status` apart by content: it mentions a
 * body field the provider sends on that status and on no 2xx, or it
 * acts on the falsy side of a field only a success can make truthy.
 */
export function consumerDiscriminatesByContent(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): (status: number) => boolean {
  const failureFields = failureOnlyBodyFields(provider);
  const read = bodyFieldsConsumerReads(consumer);
  const missing = missingFieldArms(provider, consumer);
  return (status) =>
    handledOnMissingField(missing, status) ||
    failureFields.some(
      (entry) =>
        status >= entry.min &&
        status <= entry.max &&
        [...entry.fields].some((field) => read.has(field)),
    );
}

/** One response the provider sends: the statuses it covers and its body. */
interface SentBody {
  min: number;
  max: number;
  body: TypeShape | null;
}

function sentBodies(provider: BehavioralSummary): SentBody[] {
  const out: SentBody[] = [];
  for (const t of provider.transitions) {
    if (t.output.type !== "response") {
      continue;
    }
    const span = responseStatusSpan(t);
    if (span !== null) {
      out.push({ ...span, body: t.output.body });
    }
  }
  return out;
}

/**
 * Whether reading `field` off this body gives a falsy value: the record
 * provably lacks it, or declares it as `false`, `0`, `""`, null or
 * undefined. A union needs every variant to.
 */
function fieldIsFalsy(shape: TypeShape, field: string): boolean {
  if (shape.type === "union") {
    return shape.variants.every((variant) => fieldIsFalsy(variant, field));
  }
  if (shape.type !== "record") {
    return false;
  }
  const declared = shape.properties[field];
  if (declared === undefined) {
    return (shape.spreads?.length ?? 0) === 0;
  }
  return isFalsyShape(declared);
}

function isFalsyShape(shape: TypeShape): boolean {
  if (shape.type === "null" || shape.type === "undefined") {
    return true;
  }
  if (shape.type === "union") {
    return shape.variants.every(isFalsyShape);
  }
  return shape.type === "literal" && !shape.value;
}

/** The property a derivation reads, or null when it reads none. */
function propertyRead(
  ref: Extract<ValueRef, { type: "derived" }>,
): string | null {
  if (ref.derivation.type === "propertyAccess") {
    return ref.derivation.property;
  }
  if (ref.derivation.type === "destructured") {
    return ref.derivation.field;
  }
  return null;
}

/** Each step of a reference from its root outward: `response`, `json`, `exists`. */
function readsOf(ref: ValueRef): string[] {
  if (ref.type === "derived") {
    const step = propertyRead(ref);
    return step === null ? [] : [...readsOf(ref.from), step];
  }
  if (ref.type === "dependency") {
    return [...ref.name.split("."), ...ref.accessChain];
  }
  if (ref.type === "input") {
    return [ref.inputRef, ...ref.path];
  }
  return [];
}

/** The value a condition requires to be falsy, `data.exists` in `!data.exists`. */
function testedFalsy(condition: Predicate): ValueRef | null {
  if (condition.type === "truthinessCheck") {
    return condition.negated ? condition.subject : null;
  }
  if (
    condition.type === "negation" &&
    condition.operand.type === "truthinessCheck" &&
    !condition.operand.negated
  ) {
    return condition.operand.subject;
  }
  return null;
}

/**
 * The body field a condition requires to be falsy, `exists` in
 * `!data.exists` after `data = await res.json()`. Only a field read
 * straight off the body accessor counts, so a test of some other value
 * that happens to share a field's name is left out.
 */
function falsyBodyField(
  condition: Predicate,
  accessors: ReadonlySet<string>,
): string | null {
  const tested = testedFalsy(condition);
  if (tested === null) {
    return null;
  }
  const reads = readsOf(tested);
  const at = reads.findIndex((name) => accessors.has(name));
  const rest = at === -1 ? [] : reads.slice(at + 1);
  return rest.length === 1 ? (rest[0] as string) : null;
}

/**
 * Each arm the consumer wrote for a body field being falsy, with that
 * field. An arm counts when it throws, or when an effect on it runs only
 * under that test. `if (data.exists) {...}` with no `else` still has a
 * falsy path, but the code does nothing on it.
 */
function armsOnMissingField(
  consumer: BehavioralSummary,
  accessors: ReadonlySet<string>,
): Array<{ field: string; branch: Transition }> {
  const arms: Array<{ field: string; branch: Transition }> = [];
  for (const branch of consumer.transitions) {
    if (branch.isDefault) {
      continue;
    }
    for (const condition of branch.conditions) {
      const field = falsyBodyField(condition, accessors);
      if (field === null) {
        continue;
      }
      const acts =
        branch.output.type === "throw" ||
        branch.effects.some(
          (effect) =>
            effect.type === "invocation" &&
            (effect.preconditions ?? []).some(
              (pre) => falsyBodyField(pre, accessors) === field,
            ),
        );
      if (acts) {
        arms.push({ field, branch });
      }
    }
  }
  return arms;
}

/** A consumer's arms for a missing body field, and what the provider sends, read once per pair. */
interface MissingFieldArms {
  arms: Array<{ field: string; branch: Transition }>;
  sent: SentBody[];
  successFields: Set<string>;
  bodyFields: Set<string>;
  accessors: ReadonlySet<string>;
  statusAccessors: StatusAccessors;
  successAccessors: StatusAccessors;
}

function missingFieldArms(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): MissingFieldArms {
  const accessors = new Set(bodyAccessorsFor(consumer));
  const sent = sentBodies(provider);
  return {
    arms: armsOnMissingField(consumer, accessors),
    sent,
    successFields: new Set(
      sent
        .filter((r) => r.min >= 200 && r.max < 300)
        .flatMap((r) => [...topLevelFields(r.body)]),
    ),
    bodyFields: new Set(sent.flatMap((r) => [...topLevelFields(r.body)])),
    accessors,
    statusAccessors: statusAccessorsFor(consumer),
    successAccessors: successAccessorsFor(consumer),
  };
}

/** Whether every condition on the arm other than its test of `field` leaves the body alone. */
function testsOnlyField(
  read: MissingFieldArms,
  branch: Transition,
  field: string,
): boolean {
  return branch.conditions.every((condition) => {
    if (falsyBodyField(condition, read.accessors) === field) {
      return true;
    }
    const mentioned = new Set<string>();
    fieldsInPredicate(condition, mentioned);
    return ![...mentioned].some(
      (name) =>
        read.bodyFields.has(name) &&
        !read.statusAccessors.members.has(name) &&
        !read.successAccessors.members.has(name),
    );
  });
}

/**
 * Whether the consumer handles `status` on an arm written for a field
 * that a 2xx body sends and every body sent with `status` leaves falsy.
 * `if (data.exists) {...} else { showError() }` handles a 400 whose body
 * has no `exists`, and a 500 that sends `exists: false`. The arm must
 * test nothing else about the body, and any status guard on it must
 * admit `status`.
 */
function handledOnMissingField(
  read: MissingFieldArms,
  status: number,
): boolean {
  if (read.arms.length === 0) {
    return false;
  }
  const arriving = read.sent.filter((r) => status >= r.min && status <= r.max);
  return read.arms.some(({ field, branch }) => {
    if (!read.successFields.has(field) || arriving.length === 0) {
      return false;
    }
    if (
      !arriving.every((r) => r.body !== null && fieldIsFalsy(r.body, field))
    ) {
      return false;
    }
    const guards = guardsForBranch(
      branch,
      read.statusAccessors,
      read.successAccessors,
    );
    const admits =
      branchStatusRanges(branch.conditions, guards) === null ||
      branchHandlesStatus(branch.conditions, guards, status);
    return admits && testsOnlyField(read, branch, field);
  });
}
