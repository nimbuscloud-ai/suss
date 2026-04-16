// consumer-contract.ts — Level 3: Consumer inferred vs declared contract
//
// Checks whether the consumer depends on fields that the declared contract
// doesn't guarantee. If the consumer reads `body.role` but the declared
// schema for status 200 only has `{ id, name, email }`, the consumer
// depends on an implementation detail the provider can remove without
// violating its contract.

import { providerCoversConsumerFields } from "./body-compatibility.js";
import {
  consumerExpectedStatuses,
  makeBoundary,
  makeSide,
} from "./response-match.js";

import type {
  BehavioralSummary,
  Finding,
  TypeShape,
} from "@suss/behavioral-ir";

interface DeclaredContract {
  responses: Array<{ statusCode: number; body: TypeShape | null }>;
}

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

  for (const ct of consumer.transitions) {
    const expectedInput = ct.expectedInput;
    if (expectedInput === undefined || expectedInput === null) {
      continue;
    }

    const consumerBodyShape = unwrapBodyField(expectedInput);
    if (consumerBodyShape === null || consumerBodyShape.type !== "record") {
      continue;
    }

    const statuses = consumerExpectedStatuses(ct);
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

function readDeclaredContract(
  summary: BehavioralSummary,
): DeclaredContract | null {
  const raw = summary.metadata?.declaredContract;
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
  return { responses: validated };
}

function unwrapBodyField(shape: TypeShape): TypeShape | null {
  if (shape.type === "record" && shape.properties.body !== undefined) {
    return shape.properties.body;
  }
  return shape;
}
