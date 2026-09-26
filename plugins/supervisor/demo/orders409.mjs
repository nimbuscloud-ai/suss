/**
 * The 409 story, played through the hooks with no Claude Code involved:
 * an edit adds a 409 to POST /orders, the edit's hook blocks on the
 * client that does not handle it, the client is fixed, and the stop
 * report lists the change on both sides.
 *
 *   node plugins/supervisor/demo/orders409.mjs
 *
 * It needs the built CLI, so run `npm run build` first.
 */

import { pathToFileURL } from "node:url";

import { playRecorded, transcriptOf } from "./play.mjs";

/** @param {{ keep?: boolean, env?: Record<string, string> }} [options] */
export function playOrders409(options = {}) {
  return playRecorded("orders409.events.json", options);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { steps } = playOrders409();
  process.stdout.write(`${transcriptOf(steps)}\n`);
}
