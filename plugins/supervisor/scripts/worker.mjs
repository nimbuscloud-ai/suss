/**
 * The background worker a hook starts: `node worker.mjs <project>
 * <session id> <plugin root>`. It works through the session's queue and
 * exits when the queue is empty. SIGTERM, which the SessionEnd hook
 * sends, stops the suss it is running as well.
 */

import { workUntilDone } from "./queue.mjs";
import { Session } from "./session.mjs";
import { findSuss, runSuss } from "./suss.mjs";

/** A read that runs this long is stuck, and the next edit starts over. */
const RUN_LIMIT_MS = 10 * 60 * 1000;

const [projectDir, sessionId, pluginRoot] = process.argv.slice(2);
if (
  projectDir === undefined ||
  sessionId === undefined ||
  pluginRoot === undefined
) {
  process.stderr.write(
    "usage: node worker.mjs <project> <session id> <plugin root>\n",
  );
  process.exit(2);
}

const session = new Session(projectDir, sessionId);
const suss = findSuss(projectDir, pluginRoot);
/** @type {import("node:child_process").ChildProcess | null} */
let running = null;

process.on("SIGTERM", () => {
  running?.kill("SIGTERM");
  process.exit(0);
});

session.log(
  `worker ${process.pid} runs suss from ${suss.from} (${[suss.command, ...suss.prefix].join(" ")})`,
);
await workUntilDone(session, async (args) => {
  const started = Date.now();
  const run = await runSuss(suss, args, {
    cwd: projectDir,
    timeoutMs: RUN_LIMIT_MS,
    onSpawn: (child) => {
      running = child;
    },
  });
  running = null;
  session.log(
    `suss ${args[0]} exited ${run.code} in ${Date.now() - started}ms${run.failure === undefined ? "" : `: ${run.failure}`}`,
  );
  return run;
});
