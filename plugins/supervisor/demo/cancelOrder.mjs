/**
 * The change list story, played through the hooks with no Claude Code
 * involved. The developer asks for a cancel endpoint, and the agent
 * writes a change list of three entries before it edits. It adds the
 * route, and on the way it also gives POST /orders a 409 that nobody
 * asked for. The first stop blocks on that 409. The agent adds an
 * `explained:` line saying why the 409 stays, and the next stop passes
 * with the verdicts in the report.
 *
 *   node plugins/supervisor/demo/cancelOrder.mjs
 *
 * It needs the built CLI, so run `npm run build` first.
 */

import { pathToFileURL } from "node:url";

import { playRecorded, transcriptOf } from "./play.mjs";

/** @param {{ keep?: boolean, env?: Record<string, string> }} [options] */
export function playCancelOrder(options = {}) {
  return playRecorded("cancelOrder.events.json", options);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { steps } = playCancelOrder();
  process.stdout.write(`${transcriptOf(steps)}\n`);
}
