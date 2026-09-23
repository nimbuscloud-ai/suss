/**
 * @suss/runtime-node: the pack for what Node.js provides without an
 * import. That covers scheduling calls such as `setTimeout` and
 * `process.nextTick`, the `process` global, and the module globals
 * `__dirname`, `__filename` and `import.meta.url`.
 *
 * The pack discovers no units of its own. These calls can appear in any
 * Node code, so its recognizers run inside the units other packs have
 * already found, such as Express handlers or SQS consumers. The README
 * links the design proposal.
 */

import { z } from "zod";

import { envVarRecognizer } from "./envVars.js";
import {
  fileLocationRecognizer,
  importMetaRecognizer,
} from "./moduleSurface.js";
import { processSurfaceRecognizer } from "./processSurface.js";
import { nodeSchedulingSubUnits, schedulingRecognizer } from "./scheduling.js";

import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

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

// The adapter's extraction cache includes this version in its key, so
// bump it whenever the pack changes which units it finds or which
// effects it emits.
const PACK_VERSION = "0.2.0";

/**
 * The options in a `-f node=config.json` file. The CLI checks the file
 * against this schema before the pack factory runs.
 */
export const optionsSchema = z
  .object({
    /**
     * The kind of deployment that runtime-config reads such as
     * `process.env.X` belong to. Left off the binding unless a run sets it.
     */
    deploymentTarget: z
      .enum(["lambda", "ecs-task", "container", "k8s-deployment"])
      .optional(),
    /**
     * The deployed instance the reads belong to. Left off the binding
     * unless a run sets it.
     */
    instanceName: z.string().optional(),
  })
  .strict();

export type NodeRuntimePackOptions = z.infer<typeof optionsSchema>;

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
    environmentObjects: ["process.env"],
    accessRecognizers: [
      // envRecognizer handles `process.env.X` and processRecognizer skips
      // it, so each `process.*` read produces one effect.
      envRecognizer,
      processRecognizer,
      importMetaRecognizer,
      fileLocationRecognizer,
    ],
    subUnits: nodeSchedulingSubUnits,
  };
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/runtime-node",
  dependencies: [],
  shippedWith: "typescript",
  reads:
    "Node.js runtime primitives, scheduling and the \`process\` surface, each recorded as an interaction effect. A \`process.env.X\` read, or a key of a schema parsed against \`process.env\`, becomes a config-read interaction. A module-loading global becomes a metadata-read interaction.",
};

export default nodeRuntimePack;
