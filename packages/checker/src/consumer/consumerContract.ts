// consumer-contract.ts: Level 3: Consumer inferred vs declared contract
//
// Checks whether the consumer depends on fields that the declared contract
// doesn't guarantee. If the consumer reads `body.role` but the declared
// schema for status 200 only has `{ id, name, email }`, the consumer
// depends on an implementation detail the provider can remove without
// violating its contract.

import { providerCoversConsumerFields } from "../body/bodyCompatibility.js";
import {
  type DeclaredContract,
  readDeclaredContract,
  statusAccessorsFor,
  unwrapBodyField,
} from "../contract/declaredContract.js";
import {
  consumerExpectedStatuses,
  isSuccessStatus,
  makeBoundary,
  makeSide,
} from "../coverage/responseMatch.js";

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

  const anyDeclaredBody =
    contract.responses.some((r) => r.body !== null) ||
    contract.responseRanges.some((r) => r.body !== null);
  if (!anyDeclaredBody) {
    return []; // No declared body schemas to compare against
  }

  const statusAccessors = statusAccessorsFor(consumer);

  for (const ct of consumer.transitions) {
    const expectedInput = ct.expectedInput;
    if (expectedInput === undefined || expectedInput === null) {
      continue;
    }

    const consumerBodyShape = unwrapBodyField(expectedInput, consumer);
    if (consumerBodyShape.type !== "record") {
      continue;
    }

    const statuses = consumerExpectedStatuses(ct, statusAccessors);
    const toCheck =
      statuses.length > 0
        ? statuses.flatMap((status) => {
            const body = declaredBodyFor(contract, status);
            return body === null ? [] : [{ label: String(status), body }];
          })
        : ct.isDefault
          ? declaredSuccessBodies(contract)
          : [];

    for (const { label, body } of toCheck) {
      const result = providerCoversConsumerFields(body, consumerBodyShape);

      if (result === "nomatch") {
        findings.push({
          kind: "consumerContractViolation",
          boundary,
          provider: makeSide(provider),
          consumer: makeSide(consumer, ct.id),
          description: `Consumer reads fields on status ${label} that the declared contract does not promise, so it relies on something the provider never agreed to keep`,
          severity: "warning",
        });
      } else if (result === "unknown") {
        findings.push({
          kind: "lowConfidence",
          boundary,
          provider: makeSide(provider),
          consumer: makeSide(consumer, ct.id),
          description: `Cannot tell whether the fields the consumer reads on status ${label} are covered by the declared contract`,
          severity: "info",
        });
      }
    }
  }

  return findings;
}

/**
 * The body the contract declares for one status: its literal entry
 * first, then a range containing it ("4XX" for 404), then the
 * catch-all default.
 */
function declaredBodyFor(
  contract: DeclaredContract,
  status: number,
): TypeShape | null {
  const literal = contract.responses.find((r) => r.statusCode === status);
  if (literal !== undefined) {
    return literal.body;
  }
  const range = contract.responseRanges.find(
    (r) => status >= r.min && status <= r.max,
  );
  if (range !== undefined) {
    return range.body;
  }
  return contract.defaultResponse?.body ?? null;
}

/** The declared success bodies a consumer's default branch is read against. */
function declaredSuccessBodies(
  contract: DeclaredContract,
): Array<{ label: string; body: TypeShape }> {
  const literals = contract.responses.flatMap((r) =>
    isSuccessStatus(r.statusCode) && r.body !== null
      ? [{ label: String(r.statusCode), body: r.body }]
      : [],
  );
  const ranges = contract.responseRanges.flatMap((r) =>
    r.min >= 200 && r.max < 300 && r.body !== null
      ? [{ label: r.spec, body: r.body }]
      : [],
  );
  return [...literals, ...ranges];
}
