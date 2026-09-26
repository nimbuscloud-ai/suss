/**
 * Which finding in one run is the same finding in another run.
 *
 * A finding is identified by its kind, its boundary key, the summary and
 * transition on each side, and its description with whitespace
 * collapsed. Line numbers are left out, because a comment added above a
 * handler moves every line below it and changes nothing the handler
 * does. A transition id is built from the function name, the terminal,
 * the status and a hash of the guards, so an edit elsewhere in the file
 * leaves it alone.
 */

import { displayLabel } from "@suss/ir-core";

import { boundaryKey } from "../pairing/pairing.js";

import type { BoundaryBinding, Finding } from "@suss/behavioral-ir";

/**
 * The boundary key, or the display label for a binding that has no key.
 * Findings, `.sussignore` rules and changed boundaries all use this, so
 * each can be looked up in the others.
 */
export function boundaryKeyOf(binding: BoundaryBinding): string {
  return boundaryKey(binding) ?? displayLabel(binding);
}

/** The description with every run of whitespace collapsed to one space. */
export function normalizedDescription(finding: Finding): string {
  return finding.description.replace(/\s+/g, " ").trim();
}

/** A string that is equal for the same finding in two runs. */
export function findingIdentity(finding: Finding): string {
  return JSON.stringify([
    finding.kind,
    boundaryKeyOf(finding.boundary),
    finding.provider.summary,
    finding.provider.transitionId ?? null,
    finding.consumer.summary,
    finding.consumer.transitionId ?? null,
    normalizedDescription(finding),
  ]);
}
