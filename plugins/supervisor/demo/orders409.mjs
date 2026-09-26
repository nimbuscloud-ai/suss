/**
 * The 409 story, played through the hooks with no Claude Code involved.
 *
 * It copies the orders fixture, an Express service and a fetch client in
 * one project, to a temporary directory. Then it feeds each hook the
 * event recorded in orders409.events.json, applying an Edit event's
 * change to the file first, the way the Edit tool has already written
 * it by the time PostToolUse fires.
 *
 *   node plugins/supervisor/demo/orders409.mjs
 *
 * It needs the built CLI, so run `npm run build` first.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const FIXTURE = path.resolve(PLUGIN_ROOT, "../../fixtures/supervisor-orders");

/**
 * @typedef {{ hook: string, input: Record<string, unknown> }} RecordedEvent
 * @typedef {{
 *   hook: string,
 *   input: Record<string, unknown>,
 *   status: number | null,
 *   stdout: string,
 *   stderr: string,
 *   output: Record<string, unknown> | null,
 * }} Step
 */

/**
 * Plays the recorded session in a fresh copy of the fixture and returns
 * what each hook printed. The copy is removed afterwards unless
 * `keep` is set.
 *
 * @param {{ keep?: boolean, env?: Record<string, string> }} [options]
 */
export function playOrders409(options = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "suss-orders-409-"));
  fs.cpSync(FIXTURE, project, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes(".suss"),
  });
  /** @type {RecordedEvent[]} */
  const events = JSON.parse(
    fs
      .readFileSync(path.join(HERE, "orders409.events.json"), "utf8")
      .replaceAll("<project>", project.split(path.sep).join("/")),
  );

  /** @type {Step[]} */
  const steps = [];
  try {
    for (const event of events) {
      applyEdit(event.input);
      steps.push(runHook(event, project, options.env ?? {}));
    }
  } finally {
    if (options.keep !== true) {
      fs.rmSync(project, { recursive: true, force: true });
    }
  }
  return { project, steps };
}

/**
 * Writes an Edit event's change into the file, as the Edit tool does
 * before the PostToolUse hook runs.
 *
 * @param {Record<string, unknown>} input
 */
function applyEdit(input) {
  if (input.tool_name !== "Edit") {
    return;
  }
  const edit =
    /** @type {{ file_path: string, old_string: string, new_string: string }} */ (
      input.tool_input
    );
  const before = fs.readFileSync(edit.file_path, "utf8");
  if (!before.includes(edit.old_string)) {
    throw new Error(
      `${edit.file_path} does not contain the text the recorded edit replaces`,
    );
  }
  fs.writeFileSync(
    edit.file_path,
    before.replace(edit.old_string, edit.new_string),
  );
}

/**
 * @param {RecordedEvent} event
 * @param {string} project
 * @param {Record<string, string>} env
 * @returns {Step}
 */
export function runHook(event, project, env) {
  const run = spawnSync(
    process.execPath,
    [path.join(PLUGIN_ROOT, "scripts", "hook.mjs"), event.hook],
    {
      input: JSON.stringify(event.input),
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: project,
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        // A CI runner can be slow enough to miss the five-second edit
        // budget, and the demo is about what the hooks say, not when.
        SUSS_SUPERVISOR_EDIT_MS: "60000",
        ...env,
      },
    },
  );
  const stdout = run.stdout.trim();
  return {
    hook: event.hook,
    input: event.input,
    status: run.status,
    stdout,
    stderr: run.stderr,
    output: stdout.length > 0 ? JSON.parse(stdout) : null,
  };
}

/**
 * The transcript a person reads: which hook ran, after which edit, and
 * what it printed, with the text unescaped.
 *
 * @param {Step[]} steps
 */
export function transcriptOf(steps) {
  return steps
    .map((step) => [headingOf(step), ...bodyOf(step.output)].join("\n"))
    .join("\n\n");
}

/** @param {Step} step */
function headingOf(step) {
  const toolInput = /** @type {{ file_path?: string } | undefined} */ (
    step.input.tool_input
  );
  const file =
    toolInput?.file_path === undefined
      ? ""
      : ` after an Edit to ${path.relative(String(step.input.cwd), toolInput.file_path)}`;
  return `== ${step.input.hook_event_name}${file}`;
}

/** @param {Record<string, unknown> | null} output */
function bodyOf(output) {
  if (output === null) {
    return ["(prints nothing)"];
  }
  const specific = /** @type {{ additionalContext?: string } | undefined} */ (
    output.hookSpecificOutput
  );
  if (output.decision === "block") {
    return ["decision: block", String(output.reason)];
  }
  if (specific?.additionalContext !== undefined) {
    return ["additionalContext:", specific.additionalContext];
  }
  if (typeof output.systemMessage === "string") {
    return ["systemMessage:", output.systemMessage];
  }
  return [JSON.stringify(output)];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { steps } = playOrders409();
  process.stdout.write(`${transcriptOf(steps)}\n`);
}
