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

/**
 * One marker for each library a pack declares that some project file
 * imports, in pack order, at the first file `firstImporter` finds whose
 * import starts with the library's `module`.
 */
export function libraryEnvReadMarkers(
  packs: ReadonlyArray<{
    readonly name: string;
    readonly libraryEnvVars?: readonly LibraryEnvVars[];
  }>,
  firstImporter: (modulePrefix: string) => string | undefined,
): BehavioralSummary[] {
  return packs.flatMap((pack) =>
    (pack.libraryEnvVars ?? []).flatMap((declared) => {
      const importer = firstImporter(declared.module);
      return importer === undefined
        ? []
        : [libraryEnvReadMarker(pack.name, declared, importer)];
    }),
  );
}

function libraryEnvReadMarker(
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
