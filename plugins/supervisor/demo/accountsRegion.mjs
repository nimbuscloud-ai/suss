/**
 * The environment variable story, played through the hooks with no
 * Claude Code involved. A Lambda service behind a SAM template builds
 * its service once per cold start, in a helper both functions share.
 * The agent makes the helper read a new variable, the edit's hook blocks
 * because neither function declares it, and the agent adds it to the
 * template. The first stop blocks on the two functions' changed
 * environments, which no entry in the change list matches. The agent
 * writes the read the way the skill shows, and the next stop passes.
 *
 *   node plugins/supervisor/demo/accountsRegion.mjs
 *
 * It needs the built CLI, so run `npm run build` first.
 */

import { pathToFileURL } from "node:url";

import { playRecorded, transcriptOf } from "./play.mjs";

/** @param {{ keep?: boolean, env?: Record<string, string> }} [options] */
export function playAccountsRegion(options = {}) {
  return playRecorded("accountsRegion.events.json", {
    ...options,
    fixture: "supervisor-accounts",
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { steps } = playAccountsRegion();
  process.stdout.write(`${transcriptOf(steps)}\n`);
}
