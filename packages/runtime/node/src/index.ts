// @suss/runtime-node — pack for the Node.js runtime surface.
//
// Models scheduling primitives (setImmediate / setTimeout / setInterval /
// queueMicrotask / process.nextTick), the process surface (argv, exit,
// metadata), and module-loading globals (__dirname, __filename,
// import.meta.url) that aren't expressible as imports.
//
// Recognizer-only pack (no top-level discovery patterns). The pack's
// scope is widely distributed in any Node code, so it relies on
// invocationRecognizers / accessRecognizers / subUnits firing on
// whatever units other packs (Express handlers, AWS SQS consumers,
// etc.) have already discovered.
//
// See `docs/internal/proposals/runtime-node.md` for the design.

import {
  fileLocationRecognizer,
  importMetaRecognizer,
} from "./moduleSurface.js";
import { processSurfaceRecognizer } from "./processSurface.js";
import { nodeSchedulingSubUnits, schedulingRecognizer } from "./scheduling.js";

import type { PatternPack } from "@suss/extractor";

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

export interface NodeRuntimePackOptions {
  /**
   * Deployment context for runtime-config reads (process.argv).
   * Defaults to `"lambda"`.
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
  const processRecognizer = processSurfaceRecognizer({
    ...(options.deploymentTarget !== undefined
      ? { deploymentTarget: options.deploymentTarget }
      : {}),
    ...(options.instanceName !== undefined
      ? { instanceName: options.instanceName }
      : {}),
  });
  return {
    name: "node",
    protocol: "in-process",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    invocationRecognizers: [schedulingRecognizer],
    accessRecognizers: [
      processRecognizer,
      importMetaRecognizer,
      fileLocationRecognizer,
    ],
    subUnits: nodeSchedulingSubUnits,
  };
}

export default nodeRuntimePack;
