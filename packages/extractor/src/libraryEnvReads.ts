/**
 * Environment variables a library reads from its own installed code,
 * where no walk over the project goes. Without them the checker would
 * call a variable in a template unused when the library reads it on
 * every invocation. An adapter writes one marker summary per declared
 * library that some project file imports, and runtime-config pairing
 * checks the markers before it reports a variable as unused.
 */

import { functionCallBinding } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export interface LibraryEnvVars {
  /** What the library's import starts with: `@aws-lambda-powertools/`, `aws_lambda_powertools`. */
  module: string;
  /** Prefixes of the variables the library reads, such as `POWERTOOLS_`. */
  prefixes?: string[];
  /** Exact names of the variables the library reads. */
  names?: string[];
}

/** The marker for one library, placed at the first project file found importing it. */
export function libraryEnvReadMarker(
  recognition: string,
  declared: LibraryEnvVars,
  importer: string,
): BehavioralSummary {
  return {
    kind: "library",
    location: { file: importer, range: { start: 0, end: 0 }, exportName: null },
    identity: {
      name: `${declared.module} env reads`,
      exportPath: null,
      boundaryBinding: functionCallBinding({
        transport: "in-process",
        recognition,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      libraryEnvReads: {
        module: declared.module,
        ...(declared.prefixes !== undefined
          ? { prefixes: declared.prefixes }
          : {}),
        ...(declared.names !== undefined ? { names: declared.names } : {}),
      },
    },
  };
}
