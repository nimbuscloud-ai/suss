// moduleInit.ts — the summary for what a module does when it loads.
//
// Every other unit in a summary set is a function somebody calls. A
// module has behavior of its own before any of them run: the top-level
// statements execute once, when the module is first imported, and a
// service that reads its configuration there reads it there for good.
// Walking unit bodies alone never sees that read, so a service whose
// configuration is loaded once looks like a service that needs none.
//
// The read belongs to the module rather than to any handler the module
// happens to declare, so it gets a unit of its own: one per file, named
// for the file, carrying no boundary of its own. Attributing it to each
// declared handler instead would report one read as several, and a file
// that declares no handler at all — which is most of the files where
// this shows up — would still report nothing.
//
// What that means for pairing: the summary carries no `deployableUnit`,
// so `checkRuntimeConfig` scopes it by the declaring template's
// `codeScope` path, the same way it scopes any code summary whose
// deployable unit is unknown. A template that scopes a runtime to the
// project root therefore sees every module's load-time reads, which is
// what scoping a runtime to the project root says.

import { assembleSummary } from "@suss/extractor";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { ExtractorOptions, RawCodeStructure } from "@suss/extractor";
import type { SourceFile } from "ts-morph";

/** The unit name a module's load-time behavior is reported under. */
export function moduleInitName(sourceFile: SourceFile): string {
  return sourceFile.getBaseName();
}

/**
 * The summary for one module's load-time behavior, or null when
 * loading the module does nothing any pack recognized.
 *
 * The raw structure is one default branch whose terminal is `void`:
 * module initialization answers nobody, so there is no output to
 * describe and no condition to weigh, which leaves the effects as the
 * whole of what the summary says.
 */
export function moduleInitSummary(
  sourceFile: SourceFile,
  effects: Effect[],
  options?: ExtractorOptions,
): BehavioralSummary | null {
  if (effects.length === 0) {
    return null;
  }
  const end = sourceFile.getEnd();
  const raw: RawCodeStructure = {
    identity: {
      name: moduleInitName(sourceFile),
      kind: "module-init",
      file: sourceFile.getFilePath(),
      range: { start: 0, end },
      exportName: null,
      exportPath: null,
    },
    boundaryBinding: null,
    parameters: [],
    branches: [
      {
        conditions: [],
        terminal: {
          kind: "void",
          statusCode: null,
          body: null,
          exceptionType: null,
          message: null,
          component: null,
          renderTree: null,
          delegateTarget: null,
          emitEvent: null,
          location: { start: 0, end },
        },
        effects: [],
        extraEffects: effects,
        location: { start: 0, end },
        isDefault: true,
      },
    ],
    unmatchedReturns: 0,
    dependencyCalls: [],
    declaredContract: null,
  };
  return assembleSummary(raw, options);
}
