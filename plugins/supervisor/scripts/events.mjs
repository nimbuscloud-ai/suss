/**
 * What each hook does with the event Claude Code sends it, and the JSON
 * it prints back. The README says what each hook is for; this module is
 * the when and the how.
 *
 * Every handler returns the object the hook prints, or null to print
 * nothing. None of them waits past its budget: what is not ready by
 * then stays in the session record for the next hook to deliver.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  blocksStop,
  mergeResults,
  saysAnything,
  stillCounts,
} from "./policy.mjs";
import { parseSinceReport, startWorker, stopWorker } from "./queue.mjs";
import { renderEditReport, renderStopReport } from "./report.mjs";
import { Session } from "./session.mjs";
import { findSuss, runSuss, whyItFailed } from "./suss.mjs";

/** @typedef {import("./types.js").HookContext} HookContext */
/** @typedef {import("./types.js").EditResult} EditResult */
/** @typedef {import("./types.js").SinceReport} SinceReport */
/** @typedef {Record<string, unknown>} HookInput */
/** @typedef {Record<string, unknown> | null} HookOutput */

/** How long a comparison run at a stop may take. */
const COMPARE_LIMIT_MS = 60 * 1000;

/** How many characters of the behavioral diff one stop report shows. */
const DIFF_BUDGET = 5000;

/** @type {Record<string, (input: HookInput, context: HookContext) => Promise<HookOutput>>} */
const HANDLERS = {
  "session-start": sessionStarted,
  prompt: promptSubmitted,
  "after-edit": fileEdited,
  stop: agentStopping,
  "session-end": sessionEnded,
};

/**
 * @param {string} event
 * @param {HookInput} input
 * @param {HookContext} context
 */
export function handleEvent(event, input, context) {
  const handler = HANDLERS[event];
  if (handler === undefined) {
    throw new Error(
      `there is no "${event}" hook. The hooks are ${Object.keys(HANDLERS).join(", ")}.`,
    );
  }
  return handler(input, context);
}

/**
 * The paths and budgets a hook runs with, from the environment Claude
 * Code sets. The budget variables exist for tests and for a developer
 * whose project needs longer.
 *
 * @param {HookInput} input
 * @returns {HookContext}
 */
export function contextFor(input) {
  return {
    projectDir:
      process.env.CLAUDE_PROJECT_DIR ??
      (typeof input.cwd === "string" ? input.cwd : process.cwd()),
    pluginRoot:
      process.env.CLAUDE_PLUGIN_ROOT ??
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    budgets: {
      startMs: budget("SUSS_SUPERVISOR_START_MS", 85_000),
      editMs: budget("SUSS_SUPERVISOR_EDIT_MS", 5_000),
      stopMs: budget("SUSS_SUPERVISOR_STOP_MS", 45_000),
    },
  };
}

/**
 * @param {string} name
 * @param {number} fallback
 */
function budget(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Takes the baseline, waiting up to the start budget so it is taken
 * before the first edit lands. It never blocks the session.
 *
 * @param {HookInput} input
 * @param {HookContext} context
 */
async function sessionStarted(input, context) {
  const session = sessionFor(input, context);
  session.reopen();
  if (!session.hasSnapshot("baseline")) {
    startWorker(session, context);
    await waitUntil(
      () =>
        session.hasSnapshot("baseline") || session.disabledReason() !== null,
      context.budgets.startMs,
    );
  }
  return disabledNotice(session) ?? lateResults(session, "SessionStart");
}

/**
 * Keeps the prompt for the record and delivers anything the worker
 * finished since the last hook. It never blocks and never waits.
 *
 * @param {HookInput} input
 * @param {HookContext} context
 */
async function promptSubmitted(input, context) {
  const session = sessionFor(input, context);
  session.appendPrompt(typeof input.prompt === "string" ? input.prompt : "");
  if (!session.hasSnapshot("baseline")) {
    startWorker(session, context);
  }
  return disabledNotice(session) ?? lateResults(session, "UserPromptSubmit");
}

/**
 * Queues the edit, waits up to the edit budget for the worker to read
 * it, and says what it changed. It blocks on a new error, or on a new
 * warning at a boundary the edit changed.
 *
 * @param {HookInput} input
 * @param {HookContext} context
 */
async function fileEdited(input, context) {
  const started = Date.now();
  const session = sessionFor(input, context);
  if (session.disabledReason() !== null) {
    return disabledNotice(session);
  }

  const toolInput = /** @type {Record<string, unknown>} */ (
    input.tool_input ?? {}
  );
  const file = toolInput.file_path ?? toolInput.notebook_path;
  const place = session.appendEdit({
    tool: typeof input.tool_name === "string" ? input.tool_name : "unknown",
    ...(typeof file === "string" ? { file } : {}),
  });
  const late = session.claimResults();
  startWorker(session, context);

  const read = await waitUntil(
    () => session.processed() >= place || session.disabledReason() !== null,
    context.budgets.editMs - (Date.now() - started),
  );
  if (!read) {
    return editOutput(late, "an earlier edit");
  }
  return editOutput(
    [...late, ...session.claimResults()],
    late.length === 0 ? "this edit" : "the latest edits",
  );
}

/**
 * Waits for the worker to read the last edits, then reports what changed
 * since the baseline. It blocks once on each new error; otherwise the
 * developer gets the report and the baseline moves up to now.
 *
 * @param {HookInput} input
 * @param {HookContext} context
 */
async function agentStopping(input, context) {
  const session = sessionFor(input, context);
  if (!session.hasSnapshot("baseline")) {
    return disabledNotice(session);
  }

  // A write from Bash fires no edit hook, so a stop reads the project
  // once more to catch it.
  const place = session.appendEdit({ tool: "Stop" });
  startWorker(session, context);
  const read = await waitUntil(
    () => session.processed() >= place || session.disabledReason() !== null,
    context.budgets.stopMs,
  );
  if (!read) {
    return {
      systemMessage:
        "suss is still reading the latest edits, so there is no report for this turn yet. What it finds comes with the next message.",
    };
  }
  // The report covers everything since the baseline, including what the
  // waiting results say.
  session.claimResults();
  return await stopReport(session, context);
}

/**
 * Stops the worker and drops the snapshots. The prompts and the reports
 * stay in the session record.
 *
 * @param {HookInput} input
 * @param {HookContext} context
 */
async function sessionEnded(input, context) {
  const session = sessionOf(input, context);
  if (session.exists()) {
    stopWorker(session);
    session.end();
  }
  return null;
}

/**
 * @param {Session} session
 * @param {HookContext} context
 * @returns {Promise<HookOutput>}
 */
async function stopReport(session, context) {
  const suss = findSuss(context.projectDir, context.pluginRoot);
  const run = (/** @type {string[]} */ args) =>
    runSuss(suss, args, {
      cwd: context.projectDir,
      timeoutMs: COMPARE_LIMIT_MS,
    });

  const baseline = session.snapshotDir("baseline");
  const current = session.snapshotDir("current");
  const checked = await run([
    "check",
    "--dir",
    current,
    "--since",
    baseline,
    "--json",
  ]);
  const since = parseSinceReport(checked.stdout);
  if (since === null) {
    return {
      systemMessage: `suss could not compare this turn's changes. ${whyItFailed(checked)}`,
    };
  }

  const record = session.stopRecord();
  const added = since.findings.filter(stillCounts);
  const blocking = blocksStop(added, new Set(record.blocked));
  const newRun = since.run.filter((f) => !record.runReported.includes(f.kind));
  const report = {
    since:
      session.snapshotMeta("baseline")?.from === "stop"
        ? "the agent last stopped"
        : "the session started",
    diffs: await behaviorDiffs(session, run),
    added,
    resolved: since.resolved.filter(stillCounts),
    blocking,
    run: newRun,
    caveats: baselineCaveats(session),
  };
  const text = renderStopReport(report);

  if (blocking.length > 0) {
    session.setStopRecord({
      ...record,
      blocked: [...record.blocked, ...blocking.map((f) => f.identity)],
    });
    session.appendReport({ blocked: true, text });
    return { decision: "block", reason: text };
  }

  session.setStopRecord({
    ...record,
    runReported: [...record.runReported, ...newRun.map((f) => f.kind)],
  });
  moveBaselineToNow(session);
  const quiet =
    report.diffs.length +
      report.added.length +
      report.resolved.length +
      report.run.length ===
    0;
  if (quiet) {
    return null;
  }
  session.appendReport({ blocked: false, text });
  return { systemMessage: text };
}

/**
 * `suss inspect --diff` for each summaries file in both snapshots that
 * changed. The JSON form says whether anything moved; the printed form
 * says what, the way a reviewer reads it.
 *
 * @param {Session} session
 * @param {(args: string[]) => Promise<import("./types.js").SussRun>} run
 */
async function behaviorDiffs(session, run) {
  const after = session.snapshotFiles("current");
  const diffs = [];
  for (const file of session
    .snapshotFiles("baseline")
    .filter((f) => after.includes(f))) {
    const pair = [
      path.join(session.snapshotDir("baseline"), file),
      path.join(session.snapshotDir("current"), file),
    ];
    const moved = await run(["inspect", "--diff", ...pair, "--json"]);
    if (changedCount(moved.stdout) === 0) {
      continue;
    }
    const printed = await run([
      "inspect",
      "--diff",
      ...pair,
      "--budget",
      String(DIFF_BUDGET),
    ]);
    if (printed.code === 0) {
      diffs.push(printed.stdout);
    }
  }
  return diffs;
}

/** @param {string} stdout */
function changedCount(stdout) {
  try {
    const diff = JSON.parse(stdout);
    return typeof diff.changed === "number" ? diff.changed : 0;
  } catch {
    return 0;
  }
}

/** @param {Session} session */
function baselineCaveats(session) {
  const meta = session.snapshotMeta("baseline");
  if (meta?.from !== "start" || (meta.editsDuringRead ?? 0) === 0) {
    return [];
  }
  return [
    "suss finished its first read of the project after the agent had started editing, so this report may leave out part of what those first edits changed.",
  ];
}

/** @param {Session} session */
function moveBaselineToNow(session) {
  const current = session.snapshotMeta("current");
  session.promote(
    "current",
    "baseline",
    {
      edits: current?.edits ?? session.processed(),
      at: new Date().toISOString(),
      from: "stop",
    },
    { copy: true },
  );
}

/**
 * @param {EditResult[]} results
 * @param {string} subject
 * @returns {HookOutput}
 */
function editOutput(results, subject) {
  if (results.length === 0) {
    return null;
  }
  const merged = mergeResults(results);
  if (!saysAnything(merged)) {
    return null;
  }
  const text = renderEditReport(merged, subject);
  if (merged.blocking.length > 0) {
    return { decision: "block", reason: text };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: text,
    },
  };
}

/**
 * Results the worker finished after the hook that asked for them gave
 * up waiting, as context. A prompt is never blocked on them.
 *
 * @param {Session} session
 * @param {string} hookEventName
 * @returns {HookOutput}
 */
function lateResults(session, hookEventName) {
  const results = session.claimResults();
  if (results.length === 0) {
    return null;
  }
  const merged = mergeResults(results);
  if (!saysAnything(merged)) {
    return null;
  }
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: renderEditReport(merged, "an earlier edit"),
    },
  };
}

/**
 * Tells the developer once why the session is not being checked.
 *
 * @param {Session} session
 * @returns {HookOutput}
 */
function disabledNotice(session) {
  const reason = session.disabledReason();
  if (reason === null || session.toldDisabled()) {
    return null;
  }
  session.markToldDisabled();
  return { systemMessage: reason };
}

/**
 * The session's record, created when it does not exist yet.
 *
 * @param {HookInput} input
 * @param {HookContext} context
 */
function sessionFor(input, context) {
  const session = sessionOf(input, context);
  session.create();
  return session;
}

/**
 * @param {HookInput} input
 * @param {HookContext} context
 */
function sessionOf(input, context) {
  const id =
    typeof input.session_id === "string" ? input.session_id : "unknown";
  return new Session(context.projectDir, id);
}

/**
 * Polls until the condition is true or the time runs out, and says which.
 *
 * @param {() => boolean} condition
 * @param {number} ms
 */
async function waitUntil(condition, ms) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}
