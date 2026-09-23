/**
 * @suss/contract-wrangler: behavioral summaries from a Wrangler
 * configuration document.
 *
 * `name` and `main` give the deployable unit and the code it runs.
 * `vars` gives its configuration, the three binding blocks give its
 * stores, and `queues` gives the channels it sends on and drains. Each
 * `env.<name>` deploys the same Worker again, with the top-level
 * document as its default. The README describes how each summary pairs
 * with the code side.
 */

import path from "node:path";

import { codeScopePath } from "@suss/ir-core";

import { queueSummaries, RECOGNITION, storeSummaries } from "./bindings.js";
import {
  loadConfigurationDocument,
  locateConfigurationFile,
} from "./document.js";
import { environmentDocuments, runtimeConfigSummary } from "./runtimeConfig.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { WranglerDocument } from "./document.js";

export { RECOGNITION } from "./bindings.js";
export {
  CONFIGURATION_FILE_NAMES,
  type DocumentLocation,
  isConfigurationFile,
  loadConfigurationDocument,
  locateConfigurationFile,
  type WranglerDocument,
  type WranglerRecord,
} from "./document.js";
export { environmentDocuments } from "./runtimeConfig.js";

export interface WranglerToSummariesOptions {
  /** Override the logical source file recorded on each summary. */
  source?: string;
  /**
   * The directory the Worker's code is in, relative to wherever the
   * extraction run was pointed. Defaults to where the document is,
   * relative to the working directory.
   */
  codeScope?: string;
}

export function wranglerToSummaries(
  document: WranglerDocument,
  options: { source: string; codeScope: string },
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  // An environment that overrides no binding block is bound to the same
  // stores as the top level, so its store summaries repeat earlier ones.
  // Keeping the first summary under each name drops the repeats.
  const named = new Set<string>();
  for (const deployment of environmentDocuments(document)) {
    const context = {
      sourceFile: options.source,
      scriptName: deployment.scriptName,
    };
    summaries.push(
      runtimeConfigSummary(deployment, {
        sourceFile: options.source,
        codeScope: codeScopeFor(deployment.merged, options.codeScope),
      }),
    );
    for (const summary of [
      ...storeSummaries(deployment.merged, context),
      ...queueSummaries(deployment.merged, context),
    ]) {
      if (named.has(summary.identity.name)) {
        continue;
      }
      named.add(summary.identity.name);
      summaries.push(summary);
    }
  }
  return summaries;
}

/**
 * Reads a Wrangler document and returns its summaries. The path may be
 * the document itself or the directory the Worker is in.
 */
export function wranglerFileToSummaries(
  target: string,
  options: WranglerToSummariesOptions = {},
): BehavioralSummary[] {
  const located = locateConfigurationFile(target);
  if (located.kind === "missing") {
    throw new Error(`Wrangler configuration not found: ${target}`);
  }
  const document = loadConfigurationDocument(located.file);
  return wranglerToSummaries(document, {
    source: options.source ?? `${RECOGNITION}:${relativeToRun(located.file)}`,
    codeScope:
      options.codeScope ??
      codeScopePath(path.dirname(relativeToRun(located.file))),
  });
}

/**
 * A file outside the working directory keeps its absolute path, so two
 * such files never end up with the same source name.
 */
function relativeToRun(file: string): string {
  const relative = path.relative(process.cwd(), path.resolve(file));
  if (relative === "" || relative.startsWith("..")) {
    return path.resolve(file).split(path.sep).join("/");
  }
  return relative.split(path.sep).join("/");
}

/**
 * `main` often points at a bundle a build step writes. An entry that
 * matches no source file falls back to the directory, so recording it
 * does no harm when it misses.
 */
function codeScopeFor(
  document: WranglerDocument,
  scope: string,
): { kind: "codeUri"; path: string; entry?: string } {
  const main = typeof document.main === "string" ? document.main : null;
  if (main === null) {
    return { kind: "codeUri", path: scope };
  }
  const entry = codeScopePath(
    path.posix.join(scope, main.replace(/\.[cm]?[jt]sx?$/, "")),
  );
  return { kind: "codeUri", path: scope, entry };
}
