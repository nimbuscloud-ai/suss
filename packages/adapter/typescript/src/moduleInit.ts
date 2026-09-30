/**
 * moduleInit.ts: the summary for what a module does when it loads.
 *
 * The structure itself comes from the extractor, which says why a
 * module's load-time reads get a unit of their own. What is left here
 * is the ts-morph side: the file's name and extent, and the calls its
 * top-level statements make.
 *
 * For pairing: the summary has no `deployableUnit`, so `checkRuntimeConfig`
 * scopes it by the declaring template's `codeScope` path, the same way it
 * scopes any code summary whose deployable unit is unknown.
 */

import { assembleSummary, moduleInitStructure } from "@suss/extractor";

import { reportReadFailure } from "./readFailure.js";
import { functionCalledAt } from "./resolve/functionBehind.js";
import { extractInvocationEffectsAtModuleScope } from "./resolve/invocationEffects.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { ExtractorOptions } from "@suss/extractor";
import type { SourceFile } from "ts-morph";

/** The unit name a module's load-time behavior is reported under. */
export function moduleInitName(sourceFile: SourceFile): string {
  return sourceFile.getBaseName();
}

/**
 * The summary for one module's load-time behavior, or null when loading
 * the module neither does anything a pack recognized nor calls anything
 * the project declares. A file whose top level only configures its
 * dependencies has no behavior of its own to report, and summarizing it
 * would give every file in a project a summary.
 */
export function moduleInitSummary(
  sourceFile: SourceFile,
  effects: Effect[],
  options?: ExtractorOptions,
): BehavioralSummary | null {
  const calls = extractInvocationEffectsAtModuleScope(sourceFile);
  const callsProjectCode = calls.some(
    (call) => functionCalledAt(call.node) !== null,
  );
  if (effects.length === 0 && !callsProjectCode) {
    return null;
  }
  return assembleSummary(
    moduleInitStructure({
      name: moduleInitName(sourceFile),
      file: sourceFile.getFilePath(),
      range: { start: 0, end: sourceFile.getEnd() },
      effects,
      calls: calls.map((call) => call.effect),
    }),
    options,
  );
}

/**
 * The summary for a module whose top level threw while it was read. It
 * describes nothing the module does, and a gap on it gives the error, so
 * the rest of the run goes on.
 */
export function unreadModuleInitSummary(
  sourceFile: SourceFile,
  error: unknown,
  options?: ExtractorOptions,
): BehavioralSummary {
  const name = moduleInitName(sourceFile);
  const file = sourceFile.getFilePath();
  return assembleSummary(
    {
      ...moduleInitStructure({
        name,
        file,
        range: { start: 0, end: sourceFile.getEnd() },
        effects: [],
      }),
      branches: [],
      bodyContent: "statements",
      readFailure: reportReadFailure(name, file, error),
    },
    options,
  );
}
