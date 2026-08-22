// @suss/runtime-node: pack for the Node.js runtime surface.
//
// Models scheduling primitives (setImmediate / setTimeout / setInterval /
// queueMicrotask / process.nextTick), the process surface (argv, env,
// exit, metadata), and module-loading globals (__dirname, __filename,
// import.meta.url) that aren't expressible as imports.
//
// Recognizer-only pack (no top-level discovery patterns). The pack's
// scope is widely distributed in any Node code, so it relies on
// invocationRecognizers / accessRecognizers / subUnits firing on
// whatever units other packs (Express handlers, AWS SQS consumers,
// etc.) have already discovered.
//
// See `design/proposals/runtime-node.md` for the design.

import { envVarRecognizer } from "./envVars.js";
import {
  fileLocationRecognizer,
  importMetaRecognizer,
} from "./moduleSurface.js";
import { processSurfaceRecognizer } from "./processSurface.js";
import { nodeSchedulingSubUnits, schedulingRecognizer } from "./scheduling.js";

import type { PatternPack } from "@suss/extractor";

export {
  type EnvVarRecognizerOptions,
  envVarRecognizer,
  findProcessEnvReads,
} from "./envVars.js";
export {
  fileLocationRecognizer,
  findBareFileLocationGlobals,
  importMetaRecognizer,
} from "./moduleSurface.js";
export {
  type ProcessSurfaceOptions,
  processSurfaceRecognizer,
} from "./processSurface.js";
export {
  nodeSchedulingSubUnits,
  schedulingRecognizer,
} from "./scheduling.js";

// Pack behavior stamp, fed into the adapter's cache-invalidation
// digest (see @suss/adapter-typescript `computeAdapterPacksDigest`).
// Bumped when the merge of `process.env.X` recognition into this pack
// changed what it extracts, so warm caches from the pre-merge node
// pack (which skipped env vars) re-extract instead of returning stale
// summaries. Bump again on any future change to discovered units /
// emitted effects.
const PACK_VERSION = "0.1.0";

export interface NodeRuntimePackOptions {
  /**
   * Deployment context for runtime-config reads (process.env.X,
   * process.argv). Defaults to `"lambda"`.
   */
  deploymentTarget?: "lambda" | "ecs-task" | "container" | "k8s-deployment";
  /**
   * Instance name placeholder for runtime-config bindings the pack
   * emits. Defaults to `"<unknown>"`.
   */
  instanceName?: string;
}

export function nodeRuntimePack(
  options: NodeRuntimePackOptions = {},
): PatternPack {
  const configOptions = {
    ...(options.deploymentTarget !== undefined
      ? { deploymentTarget: options.deploymentTarget }
      : {}),
    ...(options.instanceName !== undefined
      ? { instanceName: options.instanceName }
      : {}),
  };
  const processRecognizer = processSurfaceRecognizer(configOptions);
  const envRecognizer = envVarRecognizer(configOptions);
  return {
    name: "node",
    version: PACK_VERSION,
    protocol: "in-process",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    invocationRecognizers: [schedulingRecognizer],
    accessRecognizers: [
      // `envRecognizer` owns `process.env.X`; `processRecognizer`
      // owns the rest of the process surface and skips env reads,
      // together they partition `process.*` without duplication.
      envRecognizer,
      processRecognizer,
      importMetaRecognizer,
      fileLocationRecognizer,
    ],
    subUnits: nodeSchedulingSubUnits,
  };
}

export default nodeRuntimePack;
