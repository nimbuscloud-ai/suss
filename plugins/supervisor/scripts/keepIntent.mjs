/**
 * What /suss:keep-intent runs: turns this session's change list into
 * boundary intent documents with `suss intent keep`.
 *
 *   node keepIntent.mjs --audience "<who calls them>" [--session <id>] [--into <dir>]
 *
 * A slash command is not always told the session id, so without a usable
 * `--session` it acts on the session a hook last marked as current. The
 * change list is the one for the current request, or else the one the
 * last passing stop filed away. The documents take the summaries of the
 * code as the worker last read it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { currentSession } from "./session.mjs";
import { findSuss, runSuss } from "./suss.mjs";

/** Writing a few documents is quick; this only stops a stuck run. */
const KEEP_LIMIT_MS = 5 * 60 * 1000;

const pluginRoot =
  process.env.CLAUDE_PLUGIN_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

process.exitCode = await keepIntent(process.argv.slice(2));

/** @param {string[]} args */
async function keepIntent(args) {
  const { values } = parseArgs({
    args,
    options: {
      audience: { type: "string" },
      session: { type: "string" },
      into: { type: "string" },
    },
  });
  if (values.audience === undefined || values.audience.trim() === "") {
    return refuse(
      'keep-intent needs --audience, who calls these boundaries. Try: --audience "the web client"',
    );
  }

  const session = currentSession(projectDir, values.session);
  if (session === null || !session.exists()) {
    return refuse(
      "No session of the suss plugin is running in this project, so there is no change list to keep.",
    );
  }
  const changeList = session.latestIntentFile();
  if (changeList === null) {
    return refuse(
      `Session ${session.id} has no change list yet. The agent writes one to ${session.intentFile()} before its first edit for a request.`,
    );
  }
  if (!session.hasSnapshot("current")) {
    return refuse(
      "suss has not read the project in this session yet, so there is no code to take each when from.",
    );
  }

  const kept = await runSuss(
    findSuss(projectDir, pluginRoot),
    [
      "intent",
      "keep",
      changeList,
      "--dir",
      session.snapshotDir("current"),
      "--audience",
      values.audience,
      "--into",
      values.into ?? path.join(projectDir, "intent"),
    ],
    { cwd: projectDir, timeoutMs: KEEP_LIMIT_MS },
  );
  process.stdout.write(kept.stdout);
  process.stderr.write(kept.stderr);
  if (kept.failure !== undefined) {
    return refuse(kept.failure);
  }
  return kept.code ?? 1;
}

/** @param {string} why */
function refuse(why) {
  process.stderr.write(`${why}\n`);
  return 1;
}
