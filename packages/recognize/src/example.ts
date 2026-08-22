/**
 * Running the example that comes with every declaration.
 *
 * A pack's documentation goes stale the moment the library moves, and
 * nothing catches it. An example that the pack's own tests compile and
 * run against the declaration cannot: the day it stops matching, the
 * pack fails rather than the docs quietly lying.
 *
 * The run itself needs a compiler, which this package does not have, so
 * the caller passes one. A pack's test builds a small project with the
 * client library on disk and hands back what the recognizers emitted.
 */

import type { Effect } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

/** What a pack's example produced, and what the pack said it would. */
export interface RanExample {
  /** What the declaration matches, in the pack's own words. */
  match: string;
  /** The line of code that came with the declaration. */
  example: string;
  effects: Effect[];
}

/** How a pack's test compiles one line and runs the pack over it. */
export type RunOverCode = (code: string) => Effect[];

/**
 * Every example a pack declares, run. A declaration with no example is
 * left out, which is what the pack health check catches separately.
 */
export function runExamples(pack: PatternPack, run: RunOverCode): RanExample[] {
  const declared = pack.declarations?.declarations ?? [];
  const ran: RanExample[] = [];
  for (const declaration of declared) {
    if (declaration.example === null) {
      continue;
    }
    ran.push({
      match: declaration.name,
      example: declaration.example,
      effects: run(declaration.example),
    });
  }
  return ran;
}

/** The declarations a pack shipped without a line of code to run. */
export function examplesMissing(pack: PatternPack): string[] {
  return (pack.declarations?.declarations ?? [])
    .filter((declaration) => declaration.example === null)
    .map((declaration) => declaration.name);
}
