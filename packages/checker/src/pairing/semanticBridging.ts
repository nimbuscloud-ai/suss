/**
 * Reports provider sub-cases a consumer cannot tell apart.
 *
 * When one provider transition returns a body with a literal field,
 * such as `{ status: "deleted" }`, and another transition for the same
 * status has a different value there or no such field, the literal
 * tells the two cases apart. A consumer that never tests it treats both
 * cases the same way. A field that one transition has and another
 * lacks tells them apart in the same way.
 */

import { statusAccessorsFor } from "../contract/declaredContract.js";
import {
  consumerExpectedStatuses,
  extractResponseStatus,
  isSuccessStatus,
  makeBoundary,
  makeSide,
} from "../coverage/responseMatch.js";

import type {
  BehavioralSummary,
  Finding,
  Predicate,
  Transition,
  TypeShape,
  ValueRef,
} from "@suss/behavioral-ir";

interface DistinguishingLiteral {
  /** Property path from the body root, e.g. ["status"] or ["user", "role"] */
  path: string[];
  value: string | number | boolean;
}

/** Every literal-valued field in a shape, with its path. */
function collectBodyLiterals(
  shape: TypeShape,
  pathPrefix: string[] = [],
): DistinguishingLiteral[] {
  if (shape.type === "literal") {
    return [{ path: pathPrefix, value: shape.value }];
  }
  if (shape.type === "record") {
    const results: DistinguishingLiteral[] = [];
    for (const [key, value] of Object.entries(shape.properties)) {
      results.push(...collectBodyLiterals(value, [...pathPrefix, key]));
    }
    return results;
  }
  return [];
}

/**
 * The literal body fields that tell `transition` apart from its
 * siblings with the same status: some sibling has a different literal
 * at the same path, or does not have the path at all.
 */
function findDistinguishingLiterals(
  transition: Transition,
  siblings: Transition[],
): DistinguishingLiteral[] {
  if (
    transition.output.type !== "response" ||
    transition.output.body === null
  ) {
    return [];
  }

  const myLiterals = collectBodyLiterals(transition.output.body);
  if (myLiterals.length === 0) {
    return [];
  }

  return myLiterals.filter((lit) => {
    for (const sibling of siblings) {
      if (sibling.id === transition.id) {
        continue;
      }
      if (sibling.output.type !== "response" || sibling.output.body === null) {
        return true;
      }
      const siblingValue = getValueAtPath(sibling.output.body, lit.path);
      if (siblingValue === undefined) {
        return true;
      }
      if (siblingValue.type !== "literal" || siblingValue.value !== lit.value) {
        return true;
      }
    }
    return false;
  });
}

interface DistinguishingField {
  /** Property path from the body root, e.g. ["deletedAt"] */
  path: string[];
  /** True when this transition has the field and a sibling does not. */
  present: boolean;
}

/**
 * The fields this transition has that at least one sibling with the
 * same status lacks. A field this transition lacks is not reported,
 * since the transition has nothing to point a finding at.
 */
function findDistinguishingFields(
  transition: Transition,
  siblings: Transition[],
): DistinguishingField[] {
  if (
    transition.output.type !== "response" ||
    transition.output.body === null ||
    transition.output.body.type !== "record"
  ) {
    return [];
  }

  const myFields = collectFieldPaths(transition.output.body);
  const results: DistinguishingField[] = [];

  for (const fieldPath of myFields) {
    for (const sibling of siblings) {
      if (sibling.id === transition.id) {
        continue;
      }
      if (sibling.output.type !== "response" || sibling.output.body === null) {
        results.push({ path: fieldPath, present: true });
        break;
      }
      const siblingValue = getValueAtPath(sibling.output.body, fieldPath);
      if (siblingValue === undefined) {
        results.push({ path: fieldPath, present: true });
        break;
      }
    }
  }

  return results;
}

/**
 * The top-level field paths of a record. Nested records are not walked,
 * since top-level presence is the usual discriminator.
 */
function collectFieldPaths(
  shape: TypeShape,
  prefix: string[] = [],
): string[][] {
  if (shape.type !== "record") {
    return [];
  }
  const paths: string[][] = [];
  for (const key of Object.keys(shape.properties)) {
    paths.push([...prefix, key]);
  }
  return paths;
}

function getValueAtPath(
  shape: TypeShape,
  path: string[],
): TypeShape | undefined {
  let current: TypeShape = shape;
  for (const segment of path) {
    if (current.type !== "record") {
      return undefined;
    }
    const next = current.properties[segment];
    if (next === undefined) {
      return undefined;
    }
    current = next;
  }
  return current;
}

type ConsumerFieldTest =
  | {
      type: "equality";
      /** Property path from the response body, e.g. ["status"] */
      bodyPath: string[];
      value: string | number | boolean;
      transitionId: string;
    }
  | {
      type: "negatedEquality";
      bodyPath: string[];
      /** The value the consumer tests `!==` against. */
      value: string | number | boolean;
      transitionId: string;
    }
  | {
      type: "truthiness";
      bodyPath: string[];
      transitionId: string;
    };

/**
 * The consumer's tests on response body fields, with the body-relative
 * path and the literal compared against. `result.body.status ===
 * "deleted"` gives `["status"]` and `"deleted"`, and so does
 * `data.status === "deleted"` when `data` came from `res.json()`.
 */
function collectConsumerFieldTests(transitions: Transition[]): {
  tests: ConsumerFieldTest[];
  /** True when a condition could not be decomposed, so the tests may be incomplete (#126). */
  sawOpaqueCondition: boolean;
} {
  const tests: ConsumerFieldTest[] = [];
  let sawOpaqueCondition = false;
  for (const ct of transitions) {
    for (const pred of ct.conditions) {
      collectFieldTestsFromPredicate(pred, ct.id, tests);
      sawOpaqueCondition ||= containsOpaquePredicate(pred);
    }
  }
  return { tests, sawOpaqueCondition };
}

function containsOpaquePredicate(pred: Predicate): boolean {
  if (pred.type === "opaque") {
    return true;
  }
  if (pred.type === "compound") {
    return pred.operands.some(containsOpaquePredicate);
  }
  if (pred.type === "negation") {
    return containsOpaquePredicate(pred.operand);
  }
  return false;
}

function collectFieldTestsFromPredicate(
  pred: Predicate,
  transitionId: string,
  out: ConsumerFieldTest[],
  negated = false,
): void {
  if (pred.type === "comparison" && (pred.op === "eq" || pred.op === "neq")) {
    // The literal can be on either side.
    const extracted =
      tryExtractFieldTestBody(pred.left, pred.right) ??
      tryExtractFieldTestBody(pred.right, pred.left);
    if (extracted !== null) {
      // A `!==`, or an `===` under a negation, excludes the value.
      const isNegated = (pred.op === "neq") !== negated;
      out.push({
        type: isNegated ? "negatedEquality" : "equality",
        bodyPath: extracted.bodyPath,
        value: extracted.value,
        transitionId,
      });
    }
    return;
  }
  if (pred.type === "truthinessCheck") {
    const bodyPath = tryExtractBodyPath(pred.subject);
    if (bodyPath !== null) {
      out.push({ type: "truthiness", bodyPath, transitionId });
    }
    return;
  }
  if (pred.type === "compound") {
    for (const op of pred.operands) {
      collectFieldTestsFromPredicate(op, transitionId, out, negated);
    }
    return;
  }
  if (pred.type === "negation") {
    collectFieldTestsFromPredicate(pred.operand, transitionId, out, !negated);
  }
}

function tryExtractFieldTestBody(
  ref: ValueRef,
  lit: ValueRef,
): { bodyPath: string[]; value: string | number | boolean } | null {
  if (lit.type !== "literal" || lit.value === null) {
    return null;
  }

  const bodyPath = tryExtractBodyPath(ref);
  if (bodyPath === null) {
    return null;
  }

  return { bodyPath, value: lit.value };
}

/**
 * The body-relative property path a ValueRef reads, through an explicit
 * `.body` accessor (`result.body.status` gives `["status"]`) or through
 * a call that returns the body (`data.status` where `data` is
 * `res.json()`).
 */
function tryExtractBodyPath(ref: ValueRef): string[] | null {
  const result = extractPropertyChainWithRoot(ref);
  if (result === null) {
    return null;
  }

  const { chain, root } = result;

  const bodyIndex = chain.indexOf("body");
  if (bodyIndex >= 0 && bodyIndex < chain.length - 1) {
    return chain.slice(bodyIndex + 1);
  }

  if (
    root.type === "dependency" &&
    isBodyAccessorCall(root.name) &&
    chain.length > 0
  ) {
    return chain;
  }

  return null;
}

/** Whether a dependency is a call that returns the response body, such as fetch's `res.json()`. */
function isBodyAccessorCall(name: string): boolean {
  return name.endsWith(".json");
}

/**
 * The property names along a ValueRef's derivation chain, and the
 * ValueRef the chain starts from.
 */
function extractPropertyChainWithRoot(
  ref: ValueRef,
): { chain: string[]; root: ValueRef } | null {
  const chain: string[] = [];
  let current: ValueRef = ref;

  while (current.type === "derived") {
    if (current.derivation.type === "propertyAccess") {
      chain.unshift(current.derivation.property);
      current = current.from;
    } else {
      return chain.length > 0 ? { chain, root: current } : null;
    }
  }

  return chain.length > 0 ? { chain, root: current } : null;
}

export function checkSemanticBridging(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  const findings: Finding[] = [];
  const boundary = makeBoundary(provider, consumer);
  const statusAccessors = statusAccessorsFor(consumer);

  const providerByStatus = new Map<number, Transition[]>();
  for (const pt of provider.transitions) {
    const status = extractResponseStatus(pt);
    if (status === null) {
      continue;
    }
    if (!providerByStatus.has(status)) {
      providerByStatus.set(status, []);
    }
    providerByStatus.get(status)?.push(pt);
  }

  const { tests: consumerFieldTests, sawOpaqueCondition } =
    collectConsumerFieldTests(consumer.transitions);

  for (const [status, providerTransitions] of providerByStatus) {
    if (providerTransitions.length <= 1) {
      continue;
    }

    const consumerForStatus = consumer.transitions.filter((ct) => {
      if (ct.isDefault && isSuccessStatus(status)) {
        return true;
      }
      return consumerExpectedStatuses(ct, statusAccessors).includes(status);
    });

    if (consumerForStatus.length === 0) {
      continue; // provider coverage reports an unhandled status
    }

    for (const pt of providerTransitions) {
      const distinguishing = findDistinguishingLiterals(
        pt,
        providerTransitions,
      );

      if (distinguishing.length > 0) {
        const anyLiteralMatched = distinguishing.some((lit) =>
          consumerFieldTests.some((test) => {
            if (!pathsEqual(test.bodyPath, lit.path)) {
              return false;
            }
            if (test.type === "equality") {
              return test.value === lit.value;
            }
            if (test.type === "negatedEquality") {
              return test.value !== lit.value;
            }
            // A truthiness test on the same path is enough.
            return true;
          }),
        );

        if (!anyLiteralMatched) {
          const lit = distinguishing[0];
          // A condition the extractor could not decompose may test this
          // value, so the finding drops to low confidence (#126).
          findings.push(
            sawOpaqueCondition
              ? {
                  kind: "lowConfidence",
                  boundary,
                  provider: makeSide(provider, pt.id),
                  consumer: makeSide(consumer),
                  description: `Provider transition ${pt.id} for status ${status} produces body with ${formatPath(lit.path)} = ${JSON.stringify(lit.value)}, and no decomposed consumer branch tests for it, but a consumer condition could not be read, so it may`,
                  severity: "info",
                }
              : {
                  kind: "unhandledProviderCase",
                  boundary,
                  provider: makeSide(provider, pt.id),
                  consumer: makeSide(consumer),
                  description: `Provider transition ${pt.id} for status ${status} produces body with ${formatPath(lit.path)} = ${JSON.stringify(lit.value)}, but no consumer branch tests for this value`,
                  severity: "warning",
                },
          );
        }
        continue;
      }

      // Field presence is checked only when no literal tells the cases
      // apart, since the literal check is more specific.
      const presenceFields = findDistinguishingFields(pt, providerTransitions);

      if (presenceFields.length > 0) {
        const anyPresenceMatched = presenceFields.some((field) =>
          consumerFieldTests.some((test) =>
            pathsEqual(test.bodyPath, field.path),
          ),
        );

        if (!anyPresenceMatched) {
          const field = presenceFields[0];
          findings.push(
            sawOpaqueCondition
              ? {
                  kind: "lowConfidence",
                  boundary,
                  provider: makeSide(provider, pt.id),
                  consumer: makeSide(consumer),
                  description: `Provider transition ${pt.id} for status ${status} has body field ${formatPath(field.path)} that other transitions lack, and no decomposed consumer branch tests for it, but a consumer condition could not be read, so it may`,
                  severity: "info",
                }
              : {
                  kind: "unhandledProviderCase",
                  boundary,
                  provider: makeSide(provider, pt.id),
                  consumer: makeSide(consumer),
                  description: `Provider transition ${pt.id} for status ${status} has body field ${formatPath(field.path)} that other transitions lack, but no consumer branch tests for this field`,
                  severity: "warning",
                },
          );
        }
      }
    }
  }

  return findings;
}

function pathsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function formatPath(path: string[]): string {
  return path.join(".");
}
