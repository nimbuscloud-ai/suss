/**
 * A boundary binding read as OpenTelemetry attributes.
 *
 * A summary records what a unit can reach and a span records what it
 * did reach. Joining the two means both spell the boundary the same
 * way. suss writes the value a span gets wherever the semantic
 * conventions have a word for it, and this projection puts those values
 * under the attribute names a trace store already indexes.
 *
 * Each protocol declares its own field-to-attribute mapping next to its
 * definition, so this module has no protocol-specific code.
 */

import { semconvMappingOf } from "./semantics/registry.js";

import type { BoundaryBinding } from "./index.js";

/**
 * The binding's OpenTelemetry attributes, keyed by attribute name.
 *
 * A field the source never gave is left out, and so is a placeholder
 * value or a field the conventions have no attribute for. Every value
 * returned compares byte for byte against the same attribute on a span.
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
