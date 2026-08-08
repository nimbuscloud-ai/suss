// boundaryKey.ts — a boundary binding's keys and agreement, answered
// by its protocol's own behavior.
//
// A shared primitive: the behavioural checker pairs code summaries by
// these keys, and the intent checker pairs intent against code by the
// same keys. They MUST agree on keying or intent and code never line
// up, so it lives here next to the binding rather than in either
// checker. Each protocol's rules live in its module under
// `semantics/`; these functions only look them up.

import { allBehaviors, behaviorOf } from "./semantics/registry.js";

import type { BoundaryBinding, Semantics } from "./index.js";
import type { MatchResult } from "./typeShapeMatch.js";

/** The stable identity key a reader sees and a suppression targets. */
export function boundaryKey(binding: BoundaryBinding): string | null {
  return behaviorOf(binding.semantics).identityKey(binding.semantics);
}

/** The key the pairing pass buckets a binding under. */
export function pairingKey(binding: BoundaryBinding): string | null {
  const behavior = behaviorOf(binding.semantics);
  return (behavior.pairingKey ?? behavior.identityKey)(binding.semantics);
}

/**
 * Whether two same-bucket semantics name the same boundary. Different
 * variants never do; within a variant, the variant's agreement rule
 * decides, and a variant without one always agrees.
 */
export function semanticsAgree(a: Semantics, b: Semantics): boolean {
  if (a.name !== b.name) {
    return false;
  }
  const agree = behaviorOf(a).sidesAgree;
  return agree === undefined ? true : agree(a, b);
}

/**
 * The line a reader sees for a binding, or null when the protocol
 * has nothing to show: the protocol's display label when it defines
 * one, its identity key otherwise.
 */
export function boundaryLabel(binding: BoundaryBinding): string | null {
  const behavior = behaviorOf(binding.semantics);
  return (behavior.displayLabel ?? behavior.identityKey)(binding.semantics);
}

/**
 * `boundaryLabel`, with the variant name and recognizer standing in
 * when even the label is unnamed, for lists where every entry needs
 * some line.
 */
export function displayLabel(binding: BoundaryBinding): string {
  return (
    boundaryLabel(binding) ?? `${binding.semantics.name}:${binding.recognition}`
  );
}

/**
 * A suppression rule's hand-written boundary, normalized by the
 * protocol that claims it. An unclaimed string compares byte for
 * byte, which is what an exact key deserves: a message-bus key is
 * case-sensitive, and uppercasing it would break the rule silently.
 */
export function normalizeRuleBoundary(raw: string): string {
  const trimmed = raw.trim();
  for (const behavior of allBehaviors()) {
    if (behavior.ruleBoundary?.claims(trimmed) === true) {
      return behavior.ruleBoundary.normalize(trimmed);
    }
  }
  return trimmed;
}

/**
 * Whether the two sides of this binding exchange an HTTP response, so
 * that comparing status codes and response bodies says something about
 * them. Ask before running any response-shaped check; a queue and the
 * handler draining it answer no.
 */
export function exchangesHttpResponses(binding: BoundaryBinding): boolean {
  return behaviorOf(binding.semantics).exchangesHttpResponses;
}

/**
 * Whether this binding's protocol already reports its own unpaired
 * boundaries, so a generic unmatched list should leave it out rather
 * than say the same thing again in weaker words.
 */
export function reportsUnpairedItself(binding: BoundaryBinding): boolean {
  return behaviorOf(binding.semantics).reportsUnpairedItself;
}

/**
 * Whether a binding's declared boundary would answer a concrete HTTP
 * request, by the protocol's own matching. Null when the protocol
 * does not address its boundaries by method and path at all, so a
 * caller can tell "not that kind of boundary" apart from "that kind,
 * but this declaration cannot settle it".
 */
export function servesRequest(
  binding: BoundaryBinding,
  method: string,
  path: string,
): MatchResult | null {
  const serves = behaviorOf(binding.semantics).servesRequest;
  if (serves === undefined) {
    return null;
  }

  return serves(binding.semantics, method, path);
}
