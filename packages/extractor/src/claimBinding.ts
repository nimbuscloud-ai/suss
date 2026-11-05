/**
 * The binding a callback a pack claims gets from the unit it is written
 * in. Every adapter gives a claim its binding here, so a timer callback
 * in a route handler is the same kind of unit in each language.
 *
 * A claim runs later in the same process. Nothing reaches it at the
 * address its parent is reached at, and it never calls its parent, so
 * it takes the parent's binding only when it is another way into the
 * same unit inside the process, as a React event handler is into its
 * component. Any other claim is internal code, like a function the
 * closure walk reaches.
 */

import {
  BOUNDARY_ROLE,
  boundaryKey,
  functionCallBinding,
  leavesTheProcess,
} from "@suss/behavioral-ir";

import type {
  BehavioralSummary,
  BoundaryBinding,
  CodeUnitKind,
} from "@suss/behavioral-ir";

export function claimBinding(
  parent: BehavioralSummary,
  claimKind: CodeUnitKind,
): BoundaryBinding | null {
  const binding = parent.identity.boundaryBinding;
  if (binding === null) {
    return null;
  }
  if (sharesParentBinding(parent.kind, claimKind, binding)) {
    return binding;
  }
  return functionCallBinding({
    transport: "in-process",
    recognition: "reachable",
  });
}

/**
 * Both have to serve, or the claim would be a caller of its own parent
 * and pair with it. The binding has to stay in the process and have no
 * key, or the claim would serve a route or an export that a caller
 * elsewhere reaches only through the parent.
 */
function sharesParentBinding(
  parentKind: CodeUnitKind,
  claimKind: CodeUnitKind,
  binding: BoundaryBinding,
): boolean {
  return (
    BOUNDARY_ROLE[parentKind] === "provider" &&
    BOUNDARY_ROLE[claimKind] === "provider" &&
    !leavesTheProcess(binding) &&
    boundaryKey(binding) === null
  );
}
