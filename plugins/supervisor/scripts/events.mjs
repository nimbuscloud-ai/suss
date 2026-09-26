/**
 * What each hook does with the event Claude Code sends it, and the JSON
 * it prints back. The README says what each hook is for; this module is
 * the when and the how.
 *
 * Every handler returns the object the hook prints, or null to print
 * nothing. None of them waits past its budget: what is not ready by
 * then stays in the session record for the next hook to deliver.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  blocksOnIntent,
  blocksStop,
  mergeResults,
  saysAnything,
  stillCounts,
} from "./policy.mjs";
import { parseSinceReport, startWorker, stopWorker } from "./queue.mjs";
import {
  renderEditReport,
  renderIntentFailure,
  renderIntentReminder,
  renderStopReport,
} from "./report.mjs";
import { Session } from "./session.mjs";
import { findSuss, runSuss, whyItFailed } from "./suss.mjs";

/** @typedef {import("./types.js").HookContext} HookContext */
/** @typedef {import("./types.js").EditResult} EditResult */
/** @typedef {import("./types.js").SinceReport} SinceReport */
/** @typedef {import("./types.js").IntentVerdicts} IntentVerdicts */
/** @typedef {Record<string, unknown>} HookInput */
/** @typedef {Record<string, unknown> | null} HookOutput */

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
      compareMs: budget("SUSS_SUPERVISOR_COMPARE_MS", 60_000),
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
  session.markCurrent();
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
 * finished since the last hook. When the request has no change list
 * yet, it tells the agent where to write one. It never blocks and never
 * waits.
 *
 * @param {HookInput} input
 * @param {HookContext} context
 */
async function promptSubmitted(input, context) {
  const session = sessionFor(input, context);
  // With two sessions open in one project, the one the developer is
  // typing in is the one a slash command is about.
  session.markCurrent();
  session.appendPrompt(typeof input.prompt === "string" ? input.prompt : "");
  if (!session.hasSnapshot("baseline")) {
    startWorker(session, context);
  }
  const disabled = disabledNotice(session);
  if (disabled !== null || session.disabledReason() !== null) {
    return disabled;
  }
  const late = lateResults(session, "UserPromptSubmit");
  if (session.hasIntent()) {
    return late;
  }
  const said = /** @type {{ additionalContext?: string } | undefined} */ (
    late?.hookSpecificOutput
  )?.additionalContext;
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: [renderIntentReminder(session.intentFile()), said]
        .filter((part) => part !== undefined)
        .join("\n\n"),
    },
  };
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
  // Writing the change list changes no code, so there is nothing to read.
  if (typeof file === "string" && session.contains(file)) {
    return null;
  }
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
 * since the baseline. It blocks once on each new error, each entry of the
 * change list that is not done, and each change nobody asked for.
 * Otherwise the developer gets the report, the baseline moves up to now,
 * and the change list is put away.
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
 * Stops the worker, drops the snapshots, and takes away the mark that
 * makes this the current session. The prompts, the change lists and the
 * reports stay in the session record.
 *
 * @param {HookInput} input
 * @param {HookContext} context
 */
async function sessionEnded(input, context) {
  const session = sessionOf(input, context);
  if (session.exists()) {
    stopWorker(session);
    session.end();
    session.clearCurrent();
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
      timeoutMs: context.budgets.compareMs,
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
  const intent = session.hasIntent()
    ? await intentVerdicts(session, run)
    : null;
  const intentBlocking = blocksOnIntent(intent, new Set(record.intentBlocked));
  const blocks = blocking.length + intentBlocking.length > 0;
  const againstTheList = intent !== null && intent.kind !== "failed";
  const report = {
    since:
      session.snapshotMeta("baseline")?.from === "stop"
        ? "the agent last stopped"
        : "the session started",
    // The change list's verdicts cover every line of the diff, so the
    // report shows those instead of the diff itself.
    diffs: againstTheList ? [] : await behaviorDiffs(session, run),
    intent,
    intentBlocking: intentBlocking.length > 0,
    changeList: session.intentFile(),
    added,
    resolved: since.resolved.filter(stillCounts),
    blocking,
    run: newRun,
    // A check suss could not run is for the developer to know about and
    // not for the agent to fix, so only a report that passes says so.
    caveats: [
      ...baselineCaveats(session),
      ...(blocks || intent?.kind !== "failed"
        ? []
        : [renderIntentFailure(intent.why)]),
    ],
  };
  const text = renderStopReport(report);

  if (blocks) {
    session.setStopRecord({
      ...record,
      blocked: [...record.blocked, ...blocking.map((f) => f.identity)],
      intentBlocked: [...record.intentBlocked, ...intentBlocking],
    });
    session.appendReport({ blocked: true, text });
    return { decision: "block", reason: text };
  }

  session.setStopRecord({
    ...record,
    runReported: [...record.runReported, ...newRun.map((f) => f.kind)],
    intentBlocked: [],
  });
  moveBaselineToNow(session);
  session.archiveIntent();
  const quiet =
    intent === null &&
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
 * `suss intent check` over the change list, the baseline and the
 * current summaries, with the developer's messages for the quotes.
 *
 * @param {Session} session
 * @param {(args: string[]) => Promise<import("./types.js").SussRun>} run
 * @returns {Promise<IntentVerdicts>}
 */
async function intentVerdicts(session, run) {
  const prompts = session.file("prompts.jsonl");
  const checked = await run([
    "intent",
    "check",
    session.intentFile(),
    "--before",
    session.snapshotDir("baseline"),
    "--after",
    session.snapshotDir("current"),
    ...(fs.existsSync(prompts) ? ["--prompts", prompts] : []),
    "--json",
  ]);
  return verdictsFrom(checked);
}

/**
 * What `intent check` printed, read three ways: the verdicts; a refusal
 * under `rejected`, when the list itself is wrong and the agent can fix
 * it; or anything else, when suss ran out of time, crashed, or is a
 * release without the command.
 *
 * @param {import("./types.js").SussRun} checked
 * @returns {IntentVerdicts}
 */
function verdictsFrom(checked) {
  const printed = checked.failure === undefined ? jsonOf(checked.stdout) : null;
  if (Array.isArray(printed?.entries) && Array.isArray(printed?.notAsked)) {
    return {
      kind: "checked",
      check: /** @type {import("./types.js").IntentCheck} */ (
        /** @type {unknown} */ (printed)
      ),
    };
  }
  if (typeof printed?.rejected === "object" && printed.rejected !== null) {
    return {
      kind: "unreadable",
      why:
        typeof printed.error === "string"
          ? printed.error
          : whyItFailed(checked),
    };
  }
  return { kind: "failed", why: whyItFailed(checked) };
}

/**
 * @param {string} stdout
 * @returns {Record<string, unknown> | null}
 */
function jsonOf(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
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
