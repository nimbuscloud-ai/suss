/**
 * initPlan.mjs: what `suss init` told a project to do, as something a
 * script can run.
 *
 * The corpus used to call `extract` with a pack list written here,
 * which is a third copy of what a project needs and is not the path
 * anybody takes. Every defect the September sweep found sat between
 * what init printed and what running it did.
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
