/**
 * Runs the suss the hooks run, with the arguments it is given, for a
 * slash command to call:
 *
 *   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" intent keep <change list> ...
 *
 * It prints what suss prints and exits with its exit code.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findSuss } from "./suss.mjs";

const pluginRoot =
  process.env.CLAUDE_PLUGIN_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suss = findSuss(process.cwd(), pluginRoot);
const child = spawn(suss.command, [...suss.prefix, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: suss.shell,
  env: { ...process.env, SUSS_NO_UPDATE_NOTICE: "1" },
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  process.stderr.write(`suss could not start: ${error.message}\n`);
  process.exit(1);
});
