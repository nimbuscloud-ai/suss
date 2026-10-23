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
  const placed = withoutPlacement(finding.boundary);
  return JSON.stringify([
    finding.kind,
    placed(boundaryKeyOf(finding.boundary)),
    placed(finding.provider.summary),
    placedOrNull(placed, finding.provider.transitionId),
    placed(finding.consumer.summary),
    placedOrNull(placed, finding.consumer.transitionId),
    placed(normalizedDescription(finding)),
  ]);
}

/**
 * A deployed resource is named by its logical id after the stacks that
 * nest it, as in `ApiStack/PingFunction`, and its template's summary by
 * the template file. Moving the resource into a nested stack changes
 * both and leaves what the finding says about the resource alone, so
 * the identity spells the resource by its logical id, with no template
 * file.
 */
function withoutPlacement(binding: BoundaryBinding): (text: string) => string {
  const instance = deployedInstanceOf(binding);
  if (instance === null) {
    return (text) => text;
  }
  const logicalId = instance.slice(instance.lastIndexOf("/") + 1);
  const recognition = binding.recognition;
  const templateRef = `${recognition}:`;
  return (text) => {
    const named = text.replaceAll(instance, logicalId);
    if (!named.startsWith(templateRef)) {
      return named;
    }
    const unit = named.indexOf("::", templateRef.length);
    return unit === -1 ? named : `${recognition}:${named.slice(unit)}`;
  };
}

function placedOrNull(
  placed: (text: string) => string,
  text: string | undefined,
): string | null {
  return text === undefined ? null : placed(text);
}

function deployedInstanceOf(binding: BoundaryBinding): string | null {
  const semantics: object = binding.semantics;
  if (!("instanceName" in semantics)) {
    return null;
  }
  const instance = semantics.instanceName;
  return typeof instance === "string" && instance !== "" ? instance : null;
}
