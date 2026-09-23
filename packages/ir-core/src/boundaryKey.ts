/**
 * Keys for a boundary binding, and whether two bindings agree. Each
 * function looks up the binding's protocol and delegates to it, so the
 * rules are defined with each protocol's semantics.
 *
 * The behavioral checker pairs code summaries by these keys, and the
 * intent checker pairs intent against code by the same keys. If the two
 * keyed differently, intent and code would stop lining up, so the
 * keying is defined next to the binding and neither checker has its
 * own.
 */

import { allBehaviors, behaviorOf } from "./semantics/registry.js";

import type { Reference } from "./boundaryName.js";
import type { Deployment } from "./deployment.js";
import type { BoundaryBinding, Semantics } from "./index.js";
import type { MatchResult } from "./typeShapeMatch.js";

/**
 * Whether a binding is of one protocol, narrowing its semantics to that
 * protocol's type. `name` only accepts a protocol that exists. Comparing
 * `binding?.semantics.name` by hand does not narrow, and a misspelled
 * protocol name there compiles and never matches.
 */
export function bindingIs<N extends Semantics["name"]>(
  binding: BoundaryBinding | null | undefined,
  name: N,
): binding is BoundaryBinding & { semantics: Extract<Semantics, { name: N }> } {
  return binding?.semantics.name === name;
}

export function boundaryKey(binding: BoundaryBinding): string | null {
  return behaviorOf(binding.semantics).identityKey(binding.semantics);
}

/**
 * The binding with every filesystem path in its semantics rewritten.
 * The CLI uses it to make a summary's paths project-relative. A binding
 * whose protocol has no paths comes back unchanged.
 */
export function withRewrittenPaths(
  binding: BoundaryBinding,
  rewrite: (path: string) => string,
): BoundaryBinding {
  const behavior = behaviorOf(binding.semantics);
  if (behavior.rewritePaths === undefined) {
    return binding;
  }
  return {
    ...binding,
    semantics: behavior.rewritePaths(binding.semantics, rewrite),
  };
}

/**
 * The pairing key after the deployment's values are filled into the
 * boundary's name.
 *
 * A consumer that gets its base URL at run time writes a different
 * string from the provider it reaches, though the two are one boundary.
 * A protocol whose names are fixed in the source gets the same key as
 * `pairingKey` would give.
 */
export function groundedPairingKey(
  binding: BoundaryBinding,
  deployment: Deployment,
): string | null {
  return pairingKey(groundBinding(binding, deployment));
}

/**
 * The same boundary, with the deployment's values filled into its name.
 *
 * The pairing pass, the drafter that writes an intent document and the
 * intent checker that reads one back all ground a binding here before
 * reading its name. If only one of them grounded it, the drafter could
 * write a name the checker then disputes.
 */
export function groundBinding(
  binding: BoundaryBinding,
  deployment: Deployment,
): BoundaryBinding {
  const behavior = behaviorOf(binding.semantics);
  const grounded = behavior.groundName?.(binding.semantics, deployment) ?? null;
  return grounded === null ? binding : { ...binding, semantics: grounded };
}

/**
 * The reference in this boundary's name, or null when the source gave
 * the name outright. A report that explains why two sides did not pair
 * uses it to say which input would settle the name.
 */
export function nameReference(binding: BoundaryBinding): Reference | null {
  return (
    behaviorOf(binding.semantics).nameReference?.(binding.semantics) ?? null
  );
}

export function pairingKey(binding: BoundaryBinding): string | null {
  const behavior = behaviorOf(binding.semantics);
  return (behavior.pairingKey ?? behavior.identityKey)(binding.semantics);
}

export function semanticsAgree(a: Semantics, b: Semantics): boolean {
  if (a.name !== b.name) {
    return false;
  }
  const agree = behaviorOf(a).sidesAgree;
  return agree === undefined ? true : agree(a, b);
}

/** Whether the binding's bucket can meet buckets with other keys. */
export function spansBuckets(binding: BoundaryBinding): boolean {
  return (
    behaviorOf(binding.semantics).spansBuckets?.(binding.semantics) ?? false
  );
}

/** Whether two bindings' buckets describe a boundary in common. */
export function bucketsMeet(a: BoundaryBinding, b: BoundaryBinding): boolean {
  if (a.semantics.name !== b.semantics.name) {
    return false;
  }
  const meet = behaviorOf(a.semantics).bucketsMeet;
  return meet !== undefined && meet(a.semantics, b.semantics);
}

/** How narrowly the binding's bucket states what it serves; see `compareRanks`. */
export function bucketRank(binding: BoundaryBinding): readonly number[] {
  return behaviorOf(binding.semantics).bucketRank?.(binding.semantics) ?? [];
}

export function boundaryLabel(binding: BoundaryBinding): string | null {
  const behavior = behaviorOf(binding.semantics);
  return (behavior.displayLabel ?? behavior.identityKey)(binding.semantics);
}

export function displayLabel(binding: BoundaryBinding): string {
  return (
    boundaryLabel(binding) ?? `${binding.semantics.name}:${binding.recognition}`
  );
}

/**
 * A suppression rule's boundary string, normalized by the protocol that
 * recognizes it. A string no protocol recognizes keeps its case,
 * because message-bus keys are case-sensitive and uppercasing one would
 * make the rule stop matching without any error.
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

export function exchangesHttpResponses(binding: BoundaryBinding): boolean {
  return behaviorOf(binding.semantics).exchangesHttpResponses;
}

/** Whether crossing this boundary leaves the process. */
export function leavesTheProcess(binding: BoundaryBinding): boolean {
  return behaviorOf(binding.semantics).leavesTheProcess;
}

/**
 * Whether anything can pair with this binding: it has a pairing key,
 * or its protocol pairs keyless boundaries in a dedicated pass.
 */
export function canPair(binding: BoundaryBinding): boolean {
  const behavior = behaviorOf(binding.semantics);
  if (behavior.canPair !== undefined) {
    return behavior.canPair(binding.semantics);
  }
  return pairingKey(binding) !== null;
}

export function reportsUnpairedItself(binding: BoundaryBinding): boolean {
  return behaviorOf(binding.semantics).reportsUnpairedItself;
}

/**
 * Whether this binding serves a request with the given method and path.
 *
 * Null means the protocol does not address its boundaries by method and
 * path at all. A caller has to tell that apart from `"unknown"`, which
 * means the protocol does, but this declaration cannot settle it.
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

/**
 * Whether a wrapper registered for `scope` runs for this boundary.
 * False for a protocol whose boundaries no pattern addresses, so a
 * scoped registration reaches nothing it cannot be shown to cover.
 */
export function withinScope(binding: BoundaryBinding, scope: string): boolean {
  const within = behaviorOf(binding.semantics).withinScope;
  return within === undefined ? false : within(binding.semantics, scope);
}
