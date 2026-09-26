/**
 * The background worker's side of the session: it takes the baseline,
 * then reads each queued edit and writes down what changed.
 *
 * A hook waits for the worker only as long as its budget allows. When a
 * large project takes longer, the worker keeps going on its own and
 * writes its result into the session record, and whichever hook runs
 * next delivers it. One worker runs per session at a time, guarded by a
 * lock file with its process id in it.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { editResult, saysAnything } from "./policy.mjs";
import { whyItFailed } from "./suss.mjs";

/** @typedef {import("./session.mjs").Session} Session */
/** @typedef {import("./types.js").HookContext} HookContext */
/** @typedef {import("./types.js").EditResult} EditResult */
/** @typedef {import("./types.js").SinceReport} SinceReport */
/** @typedef {import("./types.js").SussRun} SussRun */
/** @typedef {(args: string[]) => Promise<SussRun>} RunSuss */

/**
 * Starts a worker for the session unless one is already running. The
 * worker is detached, so the hook that started it can exit first.
 *
 * @param {Session} session
 * @param {HookContext} context
 */
export function startWorker(session, context) {
  if (isAlive(lockHolder(session))) {
    return;
  }
  const child = spawn(
    process.execPath,
    [
      path.join(context.pluginRoot, "scripts", "worker.mjs"),
      session.projectDir,
      session.id,
      context.pluginRoot,
    ],
    {
      cwd: session.projectDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
}

/**
 * Stops the session's worker and the suss it is running. The worker is
 * the leader of its own process group, so signalling the group reaches
 * both. Windows has no process groups, and there the worker's own
 * SIGTERM handler stops the suss it started.
 *
 * @param {Session} session
 */
export function stopWorker(session) {
  const pid = lockHolder(session);
  if (!isAlive(pid) || signalled(-pid)) {
    return;
  }
  signalled(pid);
}

/**
 * Sends SIGTERM and says whether it arrived. A process that exited a
 * moment ago is not an error here.
 *
 * @param {number} pid
 */
function signalled(pid) {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/**
 * Works through the queue until nothing is left or another worker has
 * the lock. After letting go of the lock it looks once more, because a
 * hook that queued an edit at that moment saw the lock taken and started
 * no worker of its own.
 *
 * @param {Session} session
 * @param {RunSuss} run
 */
export async function workUntilDone(session, run) {
  while (session.hasWork() && takeLock(session)) {
    try {
      await drain(session, run);
    } finally {
      fs.rmSync(session.file("worker.lock"), { force: true });
    }
  }
}

/**
 * @param {Session} session
 * @param {RunSuss} run
 */
async function drain(session, run) {
  while (session.hasWork()) {
    if (!session.hasSnapshot("baseline")) {
      await takeBaseline(session, run);
      continue;
    }
    await readEdits(session, run, session.editCount());
  }
}

/**
 * Reads the project before any edit. When suss cannot read it at all,
 * the session is switched off with the reason, since every later
 * comparison would fail the same way.
 *
 * @param {Session} session
 * @param {RunSuss} run
 */
async function takeBaseline(session, run) {
  const queued = session.editCount();
  const extracted = await run(["extract", "--out-dir", session.freshNext()]);
  if (session.snapshotFiles("next").length === 0) {
    session.disable(
      `suss could not read this project, so it is not checking edits in this session. ${whyItFailed(extracted)}`,
    );
    return;
  }

  const meta = {
    edits: queued,
    at: new Date().toISOString(),
    from: /** @type {const} */ ("start"),
    editsDuringRead: session.editCount() - queued,
  };
  session.promote("next", "current", meta);
  session.promote("current", "baseline", meta, { copy: true });
  session.setProcessed(queued);
}

/**
 * Reads the project again, compares it with the summaries from before
 * these edits, and writes down what the hook should say. A read that
 * lost part of the project is not compared, because every unit in the
 * missing part would show up as removed.
 *
 * @param {Session} session
 * @param {RunSuss} run
 * @param {number} target
 */
async function readEdits(session, run, target) {
  const extracted = await run(["extract", "--out-dir", session.freshNext()]);
  const after = session.snapshotFiles("next");
  const lost = session
    .snapshotFiles("current")
    .filter((f) => !after.includes(f));
  if (extracted.failure !== undefined || lost.length > 0) {
    finish(session, target, note(target, "read", extracted));
    return;
  }

  const checked = await run([
    "check",
    "--dir",
    session.snapshotDir("next"),
    "--since",
    session.snapshotDir("current"),
    "--json",
  ]);
  const report = parseSinceReport(checked.stdout);
  if (report === null) {
    finish(session, target, note(target, "compare", checked));
    return;
  }

  session.promote("next", "current", {
    edits: target,
    at: new Date().toISOString(),
  });
  const result = editResult(report, target);
  finish(session, target, saysAnything(result) ? result : null);
}

/**
 * The result goes in before the progress moves, so a hook that sees the
 * progress also finds the result.
 *
 * @param {Session} session
 * @param {number} target
 * @param {EditResult | null} result
 */
function finish(session, target, result) {
  if (result !== null) {
    session.writeResult(result);
  }
  session.setProcessed(target);
}

/**
 * @param {number} target
 * @param {"read" | "compare"} step
 * @param {SussRun} run
 * @returns {EditResult}
 */
function note(target, step, run) {
  return {
    covers: target,
    changed: [],
    blocking: [],
    resolved: [],
    notes: [
      `could not ${step} the project after the latest edit, so this edit went unchecked. ${whyItFailed(run)}`,
    ],
  };
}

/**
 * The `check --since --json` report, or null when the output is not one,
 * as happens when check fails before it compares anything.
 *
 * @param {string} stdout
 * @returns {SinceReport | null}
 */
export function parseSinceReport(stdout) {
  try {
    const report = JSON.parse(stdout);
    return Array.isArray(report?.findings) &&
      Array.isArray(report?.changedBoundaries)
      ? report
      : null;
  } catch {
    return null;
  }
}

/** @param {Session} session */
function takeLock(session) {
  const lock = session.file("worker.lock");
  if (claimFile(lock)) {
    return true;
  }
  if (isAlive(lockHolder(session))) {
    return false;
  }
  // The worker that wrote this lock died without removing it.
  fs.rmSync(lock, { force: true });
  return claimFile(lock);
}

/** @param {string} lock */
function claimFile(lock) {
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** @param {Session} session */
function lockHolder(session) {
  try {
    return Number(fs.readFileSync(session.file("worker.lock"), "utf8"));
  } catch {
    return 0;
  }
}

/** @param {number} pid */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}
