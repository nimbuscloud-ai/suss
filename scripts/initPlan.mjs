/**
 * initPlan.mjs: what `suss init` told a project to do, as something a
 * script can run.
 *
 * The corpus runs the commands init prints rather than a pack list of
 * its own, so a pack init forgets to suggest, or a command it prints
 * that fails, shows up as a corpus failure instead of only on a user's
 * machine.
 */

import { spawnSync } from "node:child_process";

/** A config file init said to write, and the JSON to put in it. */
const CONFIG_LINE = /^\s*Write that to (\S+):\s*$/;
/** Three spaces and `suss`, which is how init prints a command. */
const COMMAND_LINE = /^ {3}(suss (?:extract|contract|check) .+)$/;

/** Run `suss init --plain` over a directory and read back the plan. */
export function initPlan(bin, directory) {
  const run = spawnSync(process.execPath, [bin, "init", directory, "--plain"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new Error(
      `suss init failed on ${directory}:\n${(run.stderr ?? "").slice(-2000)}`,
    );
  }
  return { ...planFrom(run.stdout ?? ""), output: run.stdout ?? "" };
}

/** The config files and the commands written in one init report. */
export function planFrom(output) {
  const lines = output.split("\n");
  const configs = {};
  const commands = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const config = CONFIG_LINE.exec(line);
    if (config !== null) {
      const contents = (lines[index + 1] ?? "").trim();
      if (contents.startsWith("{")) {
        configs[config[1]] = contents;
      }
      continue;
    }

    const command = COMMAND_LINE.exec(line);
    if (command !== null) {
      commands.push(command[1]);
    }
  }
  return { configs, commands };
}
