/**
 * A boundary binding read as OpenTelemetry attributes.
 *
 * A summary says what a unit can reach and a span says what it did
 * reach. Joining the two means both sides spelling the boundary the
 * same way, so suss writes the value a span gets wherever the semantic
 * conventions have a word for it, and this projection puts those
 * values under the attributes a trace store already indexes.
 *
 * Which fields those are is each protocol's own declaration, in its
 * module under `semantics/`. Nothing here knows about any protocol.
 */

import { semconvMappingOf } from "./semantics/registry.js";

import type { BoundaryBinding } from "./index.js";

/**
 * The attributes a boundary states, by name. A field the source never
 * gave, a placeholder, and a field the conventions have no attribute
 * for are all left out, so every pair here compares byte for byte
 * against the same attribute on a span.
 */
export function semconvAttributes(
  binding: BoundaryBinding,
): Record<string, string> {
  const semantics = binding.semantics as unknown as Record<string, unknown>;
  const attributes: Record<string, string> = {};
  for (const [field, attribute] of Object.entries(
    semconvMappingOf(binding.semantics),
  )) {
    const value = semantics[field];
    if (typeof value !== "string") {
      continue;
    }
    if (attribute.placeholderValues?.includes(value) === true) {
      continue;
    }
    attributes[attribute.name] = value;
  }
  return attributes;
}
