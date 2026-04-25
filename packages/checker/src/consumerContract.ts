// consumer-contract.ts — Level 3: Consumer inferred vs declared contract
//
// Checks whether the consumer depends on fields that the declared contract
// doesn't guarantee. If the consumer reads `body.role` but the declared
// schema for status 200 only has `{ id, name, email }`, the consumer
// depends on an implementation detail the provider can remove without
// violating its contract.

import { providerCoversConsumerFields } from "./bodyCompatibility.js";
import {
  bodyAccessorsFor,
  readDeclaredContract,
  statusAccessorsFor,
} from "./declaredContract.js";
import {
  consumerExpectedStatuses,
  makeBoundary,
  makeSide,
} from "./responseMatch.js";

import type {
  BehavioralSummary,
  Finding,
  TypeShape,
} from "@suss/behavioral-ir";

export function checkConsumerContract(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  const contract = readDeclaredContract(provider);
  if (!contract) {
    return [];
  }

  const findings: Finding[] = [];
  const boundary = makeBoundary(provider, consumer);

  // Build a map of declared body schemas by status code
  const declaredBodies = new Map<number, TypeShape>();
  for (const r of contract.responses) {
    if (r.body !== null) {
      declaredBodies.set(r.statusCode, r.body);
    }
  }

  if (declaredBodies.size === 0) {
    return []; // No declared body schemas to compare against
  }

  const statusAccessors = statusAccessorsFor(consumer);

  for (const ct of consumer.transitions) {
    const expectedInput = ct.expectedInput;
    if (expectedInput === undefined || expectedInput === null) {
      continue;
    }

    const consumerBodyShape = unwrapBodyField(expectedInput, consumer);
    if (consumerBodyShape === null || consumerBodyShape.type !== "record") {
      continue;
    }

    const statuses = consumerExpectedStatuses(ct, statusAccessors);
    const statusesToCheck =
      statuses.length > 0
        ? statuses
        : ct.isDefault
          ? [...declaredBodies.keys()].filter((s) => s >= 200 && s < 300)
          : [];

    for (const status of statusesToCheck) {
      const declaredBody = declaredBodies.get(status);
      if (declaredBody === undefined) {
        continue; // No declared body for this status
      }

      const result = providerCoversConsumerFields(
        declaredBody,
        consumerBodyShape,
      );

      if (result === "nomatch") {
        findings.push({
          kind: "consumerContractViolation",
          boundary,
          provider: makeSide(provider),
          consumer: makeSide(consumer, ct.id),
          description: `Consumer reads fields from status ${status} response that the declared contract does not include — consumer depends on undeclared implementation details`,
          severity: "warning",
        });
      } else if (result === "unknown") {
        findings.push({
          kind: "lowConfidence",
          boundary,
          provider: makeSide(provider),
          consumer: makeSide(consumer, ct.id),
          description: `Cannot determine whether consumer's field expectations for status ${status} are covered by the declared contract`,
          severity: "info",
        });
      }
    }
  }

  return findings;
}

function unwrapBodyField(
  shape: TypeShape,
  consumer: BehavioralSummary,
): TypeShape | null {
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
