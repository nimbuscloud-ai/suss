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

import { nodeSchedulingSubUnits, schedulingRecognizer } from "./scheduling.js";

import type { PatternPack } from "@suss/extractor";

export {
  nodeSchedulingSubUnits,
  schedulingRecognizer,
} from "./scheduling.js";

export function nodeRuntimePack(): PatternPack {
  return {
    name: "node",
    protocol: "in-process",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    invocationRecognizers: [schedulingRecognizer],
    subUnits: nodeSchedulingSubUnits,
  };
}

export default nodeRuntimePack;
