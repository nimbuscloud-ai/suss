/**
 * The GraphQL rename story, played through the hooks with no Claude Code
 * involved. The agent renames a graphql-ruby field and the React query
 * that selects it, and the edit's hook blocks because the checked-in
 * schema does not declare the new name, so the agent updates it. The
 * first stop blocks on a change list that says the old field changes,
 * since the diff shows it removed, and on the query nobody asked about.
 * The agent writes the rename as the skill shows, and the next stop
 * passes.
 *
 *   node plugins/supervisor/demo/listingRename.mjs
 *
 * It needs the built CLI, so run `npm run build` first.
 */

import { pathToFileURL } from "node:url";

import { playRecorded, transcriptOf } from "./play.mjs";

/** @param {{ keep?: boolean, env?: Record<string, string> }} [options] */
export function playListingRename(options = {}) {
  return playRecorded("listingRename.events.json", {
    ...options,
    fixture: "supervisor-listings",
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { steps } = playListingRename();
  process.stdout.write(`${transcriptOf(steps)}\n`);
}
