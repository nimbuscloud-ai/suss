import type { BehavioralSummary } from "@suss/behavioral-ir";

/** The template a summary comes from, and the line each resource is on. */
export interface TemplatePlace {
  file: string;
  lines: ReadonlyMap<string, number>;
}

export function templatePlace(
  file: string,
  lines: ReadonlyMap<string, number> = new Map(),
): TemplatePlace {
  return { file, lines };
}

/**
 * A finding on a summary built from a resource opens at the line that
 * resource is written on. A resource whose line is unknown, as in a
 * template built in memory, stays on line 1.
 */
export function locationOf(
  place: TemplatePlace,
  logicalId: string,
): BehavioralSummary["location"] {
  const line = place.lines.get(logicalId) ?? 1;
  return {
    file: place.file,
    range: { start: line, end: line },
    exportName: null,
  };
}
