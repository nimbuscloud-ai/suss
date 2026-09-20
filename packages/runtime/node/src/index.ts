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

// Pack behavior stamp, fed into the adapter's cache-invalidation
// digest (see @suss/adapter-typescript `computeAdapterPacksDigest`).
// Bumped last for the schema readers, which add a config read per key
// of a schema parsed against `process.env`. Bump again on any future
// change to discovered units or emitted effects.
const PACK_VERSION = "0.2.0";

/**
 * What `-f node=config.json` may say. The CLI parses the file against it
 * before the factory runs.
 */
export const optionsSchema = z
  .object({
    /**
     * Deployment context for runtime-config reads (process.env.X,
     * process.argv). Defaults to `"lambda"`.
     */
    deploymentTarget: z
      .enum(["lambda", "ecs-task", "container", "k8s-deployment"])
      .optional(),
    /**
     * Instance name placeholder for runtime-config bindings the pack
     * emits. Defaults to `"<unknown>"`.
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

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/runtime-node",
  dependencies: [],
  shippedWith: "typescript",
  reads:
    "Node.js runtime primitives, scheduling, the \`process\` surface (incl. \`process.env.X\` config-read interactions and the keys of a schema parsed against \`process.env\`), module-loading globals, emitted as interaction effects.",
};

export default nodeRuntimePack;
