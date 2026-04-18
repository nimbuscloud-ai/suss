// semantic-bridging.ts — Level 5: Match provider output body literals
// against consumer comparison predicates
//
// When a provider transition produces a body with literal field values
// (e.g., { status: "deleted" }), and another transition for the same
// status code produces a different value for the same field (or omits it),
// those literals are "distinguishing signals." If no consumer transition
// tests for the distinguishing value, the consumer collapses behaviorally
// distinct cases.

import { statusAccessorsFor } from "./declared-contract.js";
import {
  consumerExpectedStatuses,
  extractResponseStatus,
  makeBoundary,
  makeSide,
} from "./response-match.js";

import type {
  BehavioralSummary,
  Finding,
  Predicate,
  Transition,
  TypeShape,
  ValueRef,
} from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Extract distinguishing literals from a provider body shape
// ---------------------------------------------------------------------------

interface DistinguishingLiteral {
  /** Property path from the body root, e.g. ["status"] or ["user", "role"] */
  path: string[];
  /** The literal value at this path */
  value: string | number | boolean;
}

/**
 * Walk a TypeShape and collect all literal-valued fields with their paths.
 */
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
 * Given multiple provider transitions for the same status code, find
 * literal body fields that differ between transitions — these are the
 * values that distinguish one sub-case from another.
 *
 * A literal is "distinguishing" if at least one other transition for the
 * same status either has a different literal at the same path, or doesn't
 * have that path at all.
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
    // Check if any sibling has a different value (or no value) at this path
    for (const sibling of siblings) {
      if (sibling.id === transition.id) {
        continue;
      }
      if (sibling.output.type !== "response" || sibling.output.body === null) {
        // Sibling has no body — this literal distinguishes
        return true;
      }
      const siblingValue = getValueAtPath(sibling.output.body, lit.path);
      if (siblingValue === undefined) {
        // Sibling doesn't have this field — distinguishing
        return true;
      }
      if (siblingValue.type !== "literal" || siblingValue.value !== lit.value) {
        // Sibling has a different value — distinguishing
        return true;
      }
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Field-presence discrimination
// ---------------------------------------------------------------------------

interface DistinguishingField {
  /** Property path from the body root, e.g. ["deletedAt"] */
  path: string[];
  /** Whether this transition HAS the field (vs sibling which doesn't) */
  present: boolean;
}

/**
 * Find fields whose presence differs between this transition and its siblings.
 * A field is "distinguishing by presence" if this transition has it but at
 * least one sibling doesn't (or vice versa).
 *
 * Only reports fields present in THIS transition but missing from a sibling
 * (we can't warn about something that isn't there).
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
 * Collect all field paths in a record shape (non-recursive into nested records
 * for now — top-level field presence is the most common discriminator).
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

// ---------------------------------------------------------------------------
// Extract body-field comparisons from consumer predicates
// ---------------------------------------------------------------------------

type ConsumerFieldTest =
  | {
      type: "equality";
      /** Property path from the response body, e.g. ["status"] */
      bodyPath: string[];
      /** The literal value being compared */
      value: string | number | boolean;
      /** The transition this test appears in */
      transitionId: string;
    }
  | {
      type: "negatedEquality";
      /** Property path from the response body */
      bodyPath: string[];
      /** The literal value being excluded (consumer tests !== this value) */
      value: string | number | boolean;
      /** The transition this test appears in */
      transitionId: string;
    }
  | {
      type: "truthiness";
      /** Property path from the response body, e.g. ["deletedAt"] */
      bodyPath: string[];
      /** The transition this test appears in */
      transitionId: string;
    };

/**
 * Extract comparison predicates that test response body fields from
 * consumer transitions. Returns the body-relative path and the literal
 * value being compared.
 *
 * Recognizes patterns like:
 *   result.body.status === "deleted"  →  bodyPath: ["status"], value: "deleted"
 *   data.type === "error"             →  bodyPath: ["type"], value: "error"
 *     (if data resolves through body)
 */
function collectConsumerFieldTests(
  transitions: Transition[],
): ConsumerFieldTest[] {
  const tests: ConsumerFieldTest[] = [];
  for (const ct of transitions) {
    for (const pred of ct.conditions) {
      collectFieldTestsFromPredicate(pred, ct.id, tests);
    }
  }
  return tests;
}

function collectFieldTestsFromPredicate(
  pred: Predicate,
  transitionId: string,
  out: ConsumerFieldTest[],
  negated = false,
): void {
  if (pred.type === "comparison" && (pred.op === "eq" || pred.op === "neq")) {
    // Try both orientations: left=ref right=literal, or vice versa
    const extracted =
      tryExtractFieldTestBody(pred.left, pred.right) ??
      tryExtractFieldTestBody(pred.right, pred.left);
    if (extracted !== null) {
      // neq XOR negation context → negated equality
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
 * Extract the body-relative property path from a ValueRef.
 *
 * Two patterns are recognized:
 * 1. Explicit `.body` accessor: `result.body.status` → `["status"]`
 * 2. Body-returning call: `data.status` where data = `res.json()` → `["status"]`
 *    (the `.json()` call returns the body directly, so properties on its result
 *    are body fields)
 */
function tryExtractBodyPath(ref: ValueRef): string[] | null {
  const result = extractPropertyChainWithRoot(ref);
  if (result === null) {
    return null;
  }

  const { chain, root } = result;

  // Pattern 1: explicit "body" in the chain
  const bodyIndex = chain.indexOf("body");
  if (bodyIndex >= 0 && bodyIndex < chain.length - 1) {
    return chain.slice(bodyIndex + 1);
  }

  // Pattern 2: root is a call that returns the body directly (e.g. res.json())
  if (
    root.type === "dependency" &&
    isBodyAccessorCall(root.name) &&
    chain.length > 0
  ) {
    return chain;
  }

  return null;
}

/**
 * Check if a dependency name represents a call whose return value IS
 * the response body (e.g., `res.json()` in fetch).
 */
function isBodyAccessorCall(name: string): boolean {
  return name.endsWith(".json");
}

/**
 * Walk a ValueRef's derivation chain and extract the property names,
 * along with the root ValueRef where the chain terminates.
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
      // Non-property derivation (destructured, indexAccess, etc.) — bail
      return chain.length > 0 ? { chain, root: current } : null;
    }
  }

  return chain.length > 0 ? { chain, root: current } : null;
}

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

export function checkSemanticBridging(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  const findings: Finding[] = [];
  const boundary = makeBoundary(provider, consumer);
  const statusAccessors = statusAccessorsFor(consumer);

  // Group provider transitions by status code
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

  // Collect all body-field tests from consumer transitions
  const consumerFieldTests = collectConsumerFieldTests(consumer.transitions);

  for (const [status, providerTransitions] of providerByStatus) {
    if (providerTransitions.length <= 1) {
      continue;
    }

    // Find consumer transitions that handle this status
    const consumerForStatus = consumer.transitions.filter((ct) => {
      if (ct.isDefault && status >= 200 && status < 300) {
        return true;
      }
      return consumerExpectedStatuses(ct, statusAccessors).includes(status);
    });

    if (consumerForStatus.length === 0) {
      continue; // Status not handled — already caught by provider coverage
    }

    // For each provider transition, check two kinds of discriminators:
    // 1. Distinguishing literals (field values that differ between siblings)
    // 2. Distinguishing fields (fields present in one sibling but not another)
    for (const pt of providerTransitions) {
      // --- Literal discrimination ---
      const distinguishing = findDistinguishingLiterals(
        pt,
        providerTransitions,
      );

      if (distinguishing.length > 0) {
        // Check if any consumer field test matches ANY distinguishing literal
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
            // Truthiness or field-presence: same path is enough
            return true;
          }),
        );

        if (!anyLiteralMatched) {
          const lit = distinguishing[0];
          findings.push({
            kind: "unhandledProviderCase",
            boundary,
            provider: makeSide(provider, pt.id),
            consumer: makeSide(consumer),
            description: `Provider transition ${pt.id} for status ${status} produces body with ${formatPath(lit.path)} = ${JSON.stringify(lit.value)}, but no consumer branch tests for this value`,
            severity: "warning",
          });
        }
        continue; // Literal discrimination takes priority
      }

      // --- Field-presence discrimination ---
      // Only fires when there are no distinguishing literals (otherwise
      // the literal check above is more specific).
      const presenceFields = findDistinguishingFields(pt, providerTransitions);

      if (presenceFields.length > 0) {
        // Check if the consumer tests any of the presence-distinguishing fields
        const anyPresenceMatched = presenceFields.some((field) =>
          consumerFieldTests.some((test) =>
            pathsEqual(test.bodyPath, field.path),
          ),
        );

        if (!anyPresenceMatched) {
          const field = presenceFields[0];
          findings.push({
            kind: "unhandledProviderCase",
            boundary,
            provider: makeSide(provider, pt.id),
            consumer: makeSide(consumer),
            description: `Provider transition ${pt.id} for status ${status} has body field ${formatPath(field.path)} that other transitions lack, but no consumer branch tests for this field`,
            severity: "warning",
          });
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
