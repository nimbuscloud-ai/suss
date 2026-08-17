/**
 * @suss/contract-wrangler: behavioral summaries from a Wrangler
 * configuration document.
 *
 * A `wrangler.toml` deploys a working Worker, and before this reader
 * existed suss saw none of it: no deployable unit, no configuration
 * contract, no stores and no queues. `name` and `main` give the unit
 * and the code it runs, `vars` gives the configuration, the three
 * binding blocks give stores, `queues` gives the channels it sends on
 * and drains, and each `env.<name>` deploys the same Worker again with
 * the top-level document as its default. The README says how each half
 * pairs.
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
  // store, so the second deployment restates a boundary the first one
  // already declared. Naming each summary once collapses those.
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

/** The path may be the document itself or the directory the Worker is in. */
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
 * A path as suss writes one: relative to the run, with forward slashes.
 * A file outside the working directory keeps its absolute path, which
 * is unlovely and unique.
 */
function relativeToRun(file: string): string {
  const relative = path.relative(process.cwd(), path.resolve(file));
  if (relative === "" || relative.startsWith("..")) {
    return path.resolve(file).split(path.sep).join("/");
  }
  return relative.split(path.sep).join("/");
}

/**
 * Where the Worker's code is and which file it enters. `main` is often
 * a bundle a build step writes, and an entry nothing matches leaves the
 * directory in charge, so recording it costs nothing and helps wherever
 * it does point at source.
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
