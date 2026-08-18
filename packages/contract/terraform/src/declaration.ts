/**
 * The attribute values a pack asked the reader to carry through.
 *
 * The reader does not interpret them. A pack lists attribute paths on
 * its entry, the reader copies whatever the configuration set them to,
 * and whoever judges the resource later reads them back by the same
 * path. Both sides import this file, so a renamed field is a
 * compile error rather than a finding that quietly stops firing.
 */

import type { BehavioralSummary } from "@suss/behavioral-ir";

/** What one resource stated, as far as its pack asked. */
export interface TerraformDeclaration {
  /** The resource type, spelled the way the provider spells it. */
  resource: string;
  /** Each attribute path the pack asked for, and what it was set to. */
  attributes: Record<string, string | number | boolean>;
}

/** A metadata bag with the terraform-declaration namespace set. */
export function withTerraformDeclaration(
  metadata: Record<string, unknown> | undefined,
  value: TerraformDeclaration,
): Record<string, unknown> {
  return { ...(metadata ?? {}), terraformDeclaration: value };
}

/** What the summary states, or undefined when it states nothing. */
export function readTerraformDeclaration(
  summary: BehavioralSummary,
): TerraformDeclaration | undefined {
  const raw = summary.metadata?.terraformDeclaration;
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const { resource, attributes } = raw as Record<string, unknown>;
  if (typeof resource !== "string") {
    return undefined;
  }
  return { resource, attributes: readAttributes(attributes) };
}

/**
 * A value written as something other than a string, a number, or a
 * boolean is dropped rather than taking its siblings with it, the same
 * way the IR's own namespaces read one field at a time.
 */
function readAttributes(
  raw: unknown,
): Record<string, string | number | boolean> {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }
  const read: Record<string, string | number | boolean> = {};
  for (const [path, value] of Object.entries(raw)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      read[path] = value;
    }
  }
  return read;
}
