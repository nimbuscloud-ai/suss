/**
 * Keys for a boundary binding, and whether two of them agree. Every
 * function here asks the binding's protocol and returns whatever it
 * says, so the rules themselves are in the protocol's own module under
 * `semantics/` and not in this file.
 *
 * The sharing is the point. The behavioural checker pairs code
 * summaries by these keys, and the intent checker pairs intent against
 * code by the same keys. If the two ever keyed differently, intent and
 * code would stop lining up, so the keying is here next to the binding
 * rather than in either checker.
 */

import { allBehaviors, behaviorOf } from "./semantics/registry.js";

import type { Reference } from "./boundaryName.js";
import type { Deployment } from "./deployment.js";
import type { BoundaryBinding, Semantics } from "./index.js";
import type { MatchResult } from "./typeShapeMatch.js";

/**
 * Whether a binding is of one protocol, narrowed to that protocol's
 * own semantics when it is. A caller reaching through the binding to
 * compare the name by hand gets `string | undefined` and no narrowing,
 * so a name that no protocol uses compiles and quietly never matches.
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
 * The binding with any filesystem path its semantics state rewritten.
 * The CLI uses it to make a summary's paths project-relative, and each
 * protocol says for itself whether it states one.
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
 * The bucket a boundary pairs in, with any name the deployment fills in
 * put in first.
 *
 * A consumer that gets its base URL from the runtime states a different
 * string from the provider it reaches, and the two are one boundary.
 * Every protocol that has such a name says how to fill it in, and one
 * whose names are settled in the source keys exactly as before.
 */
export function groundedPairingKey(
  binding: BoundaryBinding,
  deployment: Deployment,
): string | null {
  return pairingKey(groundBinding(binding, deployment));
}

/**
 * The same boundary, with whatever the deployment fills in put in.
 *
 * Everything that reads a boundary's name for a person to see goes
 * through here first: the pairing pass, the drafter that writes an
 * intent document, and the intent checker that reads one back. A step
 * only one of them took would have the drafter write a name the
 * checker then argued with.
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
 * Where this boundary's name says to go and ask, or null when the
 * source stated a name outright. A report that has to say why two
 * sides did not meet reads it to say which input would settle them.
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
 * A boundary string that no protocol claims keeps its case, because
 * message-bus keys are case-sensitive and uppercasing one would break
 * the rule without saying so.
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
 * Null means the protocol does not address its boundaries by method and
 * path at all, which a caller has to tell apart from an unknown answer:
 * unknown means it does, but this declaration cannot settle the question.
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
