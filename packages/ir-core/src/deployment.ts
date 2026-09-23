/**
 * The values a deployment sets for the variables its code reads.
 *
 * A queue URL, a function name and a table name only exist once a stack
 * is deployed, so the source reaches them through a variable and the
 * template sets that variable. A protocol whose boundary name has a
 * hole in it looks the hole up through this interface.
 *
 * The interface is declared in ir-core so a protocol can use it without
 * depending on the summary types. `@suss/behavioral-ir` implements it
 * from a set of summaries.
 */

import type { Reference } from "./boundaryName.js";

export interface Deployment {
  /**
   * The variable a reference points at. Null when a caller's argument
   * settles the reference and the deployment has no say in it.
   */
  variableFor(reference: Reference): string | null;
  /**
   * The string this deployment sets that variable to. Null when it sets
   * nothing, and null when two deployments of this code set it to
   * different strings, since picking one of two would be a guess.
   */
  setTo(reference: Reference): string | null;
  /**
   * The logical id of the declared resource this deployment wires the
   * variable to. A template that writes `!Ref ArchiveWorker` never gives
   * the deployed function's name, but the unit's own summary is keyed by
   * that logical id, so an invoke can still be matched to its unit.
   */
  pointsAt(reference: Reference): string | null;
}

/** A deployment that settles nothing, for a run with no template in it. */
export const NOTHING_DEPLOYED: Deployment = {
  variableFor: () => null,
  setTo: () => null,
  pointsAt: () => null,
};
