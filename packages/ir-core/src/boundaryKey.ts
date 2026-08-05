// boundaryKey.ts — a boundary binding's keys and agreement, answered
// by its protocol's own behavior.
//
// A shared primitive: the behavioural checker pairs code summaries by
// these keys, and the intent checker pairs intent against code by the
// same keys. They MUST agree on keying or intent and code never line
// up, so it lives here next to the binding rather than in either
// checker. Each protocol's rules live in its module under
// `semantics/`; these functions only look them up.

import { behaviorOf } from "./semantics/registry.js";

import type { BoundaryBinding, Semantics } from "./index.js";

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
