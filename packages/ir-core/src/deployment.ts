/**
 * What the deployment running a piece of code fills its variables in
 * with.
 *
 * A queue URL, a function name and a table name only exist once a stack
 * is deployed, so the source reaches them through a variable and the
 * template says what that variable is. Every protocol whose name has a
 * hole in it asks the same two questions here, and whoever knows which
 * deployment runs the code fills them in.
 *
 * The interface is declared next to the protocols because a protocol
 * has to ask without knowing what a summary is. `@suss/behavioral-ir`
 * works the values out from a set of summaries.
 */

import type { Reference } from "./boundaryName.js";

export interface Deployment {
  /**
   * Which variable a reference asks about, or null when what settles it
   * is an argument a caller passes rather than anything the deployment
   * says.
   */
  variableFor(reference: Reference): string | null;
  /**
   * The string this deployment sets that variable to. Null when it sets
   * nothing, and null when two deployments of this code set it to
   * different strings, since picking one of two would be a guess.
   */
  setTo(reference: Reference): string | null;
  /**
   * The declared resource this deployment wires that variable to, by
   * the name the resource is declared under. A template that writes
   * `!Ref ArchiveWorker` says which unit an invoke reaches without ever
   * writing the deployed function's name, and that logical id is what
   * the unit's own summary is keyed by.
   */
  pointsAt(reference: Reference): string | null;
}

/** A deployment that settles nothing, for a run with no template in it. */
export const NOTHING_DEPLOYED: Deployment = {
  variableFor: () => null,
  setTo: () => null,
  pointsAt: () => null,
};
