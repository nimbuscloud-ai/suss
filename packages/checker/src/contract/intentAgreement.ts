// intentAgreement.ts — pair team-authored intent specs against
// derived / specified implementations of the same boundary.
//
// An intent summary carries `recognition: "intent"` on its boundary
// binding (produced by @suss/contract-intent). When such a summary
// shares a boundary key with one or more non-intent summaries
// (handlers, OpenAPI / CFN derivations, etc.), this checker emits
// three kinds of findings:
//
//   - intentUnimplemented: intent declares a status the
//     implementation never produces.
//   - intentExceeded:      implementation produces a status the
//     intent doesn't mention.
//   - intentFieldMismatch: shared status; body shapes disagree.
//
// All three are error severity by default — the team explicitly
// declared intent, divergence is a defect.

import { bodyShapesMatch } from "../body/bodyMatch.js";
import { makeSide } from "../coverage/responseMatch.js";
import { boundaryKey } from "../pairing/pairing.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";

/**
 * Pair every intent summary against the non-intent summaries that
 * share its boundary key. Boundaries with no intent are skipped.
 * Boundaries with intent but no implementation are reported via
 * `intentUnimplemented` against a synthetic "no implementation"
 * marker by simply not emitting (the missing-implementation case
 * is better surfaced by the existing pairing-coverage layer; this
 * checker stays focused on intent-vs-impl disagreement).
 */
export function checkIntentAgreement(
  summaries: BehavioralSummary[],
): Finding[] {
  const findings: Finding[] = [];
  const byBoundary = groupByBoundary(summaries);

  for (const group of byBoundary.values()) {
    const intents = group.summaries.filter(
      (s) => s.identity.boundaryBinding?.recognition === "intent",
    );
    if (intents.length === 0) {
      continue;
    }
    const impls = group.summaries.filter(
      (s) =>
        s.identity.boundaryBinding !== null &&
        s.identity.boundaryBinding.recognition !== "intent",
    );
    if (impls.length === 0) {
      continue;
    }
    for (const intent of intents) {
      for (const impl of impls) {
        findings.push(...compareIntentToImpl(group.boundary, intent, impl));
      }
    }
  }

  return findings;
}

interface BoundaryGroup {
  boundary: BoundaryBinding;
  summaries: BehavioralSummary[];
}

function groupByBoundary(
  summaries: BehavioralSummary[],
): Map<string, BoundaryGroup> {
  const groups = new Map<string, BoundaryGroup>();
  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null) {
      continue;
    }
    const key = boundaryKey(binding);
    if (key === null) {
      continue;
    }
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        boundary: binding,
        summaries: [summary],
      });
    } else {
      existing.summaries.push(summary);
    }
  }
  return groups;
}

function compareIntentToImpl(
  boundary: BoundaryBinding,
  intent: BehavioralSummary,
  impl: BehavioralSummary,
): Finding[] {
  const findings: Finding[] = [];
  const boundaryLabel = boundaryKey(boundary) ?? "this boundary";

  const intentByStatus = collectStatusBodies(intent.transitions);
  const implByStatus = collectStatusBodies(impl.transitions);

  for (const [status, intentBody] of intentByStatus) {
    if (!implByStatus.has(status)) {
      findings.push({
        kind: "intentUnimplemented",
        boundary,
        provider: makeSide(intent),
        consumer: makeSide(impl),
        description: `Intent declares status ${status} at ${boundaryLabel}; implementation has no transition that produces it.`,
        severity: "error",
        sources: [
          `${intent.location.file}::${intent.identity.name}`,
          `${impl.location.file}::${impl.identity.name}`,
        ],
      });
      continue;
    }
    const implBody = implByStatus.get(status) ?? null;
    if (intentBody === null || implBody === null) {
      continue;
    }
    const shapeMatch = bodyShapesMatch(intentBody, implBody);
    if (shapeMatch === "match" || shapeMatch === "unknown") {
      continue;
    }
    findings.push({
      kind: "intentFieldMismatch",
      boundary,
      provider: makeSide(intent),
      consumer: makeSide(impl),
      description: `Body shape at status ${status} disagrees with intent at ${boundaryLabel}: intent and ${impl.identity.name} declare incompatible shapes.`,
      severity: "error",
      sources: [
        `${intent.location.file}::${intent.identity.name}`,
        `${impl.location.file}::${impl.identity.name}`,
      ],
    });
  }

  for (const status of implByStatus.keys()) {
    if (intentByStatus.has(status)) {
      continue;
    }
    findings.push({
      kind: "intentExceeded",
      boundary,
      provider: makeSide(intent),
      consumer: makeSide(impl),
      description: `Implementation produces status ${status} at ${boundaryLabel}; intent does not declare it.`,
      severity: "error",
      sources: [
        `${intent.location.file}::${intent.identity.name}`,
        `${impl.location.file}::${impl.identity.name}`,
      ],
    });
  }

  return findings;
}

function collectStatusBodies(
  transitions: Transition[],
): Map<number, TypeShape | null> {
  const out = new Map<number, TypeShape | null>();
  for (const t of transitions) {
    if (t.output.type !== "response") {
      continue;
    }
    if (
      t.output.statusCode === null ||
      t.output.statusCode.type !== "literal"
    ) {
      continue;
    }
    const status = Number(t.output.statusCode.value);
    if (!Number.isFinite(status)) {
      continue;
    }
    // If the impl produces multiple transitions for the same status (a
    // happy path and a fallback that both emit 200, say), the first one
    // wins as the comparison body. The proposal flags multi-transition
    // aggregation as a v1 refinement.
    if (!out.has(status)) {
      out.set(status, t.output.body ?? null);
    }
  }
  return out;
}
