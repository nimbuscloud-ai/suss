/**
 * Starts the suss MCP server over stdio for Claude Code, found the same
 * way the hooks find suss: the project's `@suss/mcp` when it is recent
 * enough, then the plugin's own. The server reads the directory Claude
 * Code starts it in, which is the project.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findExecutable } from "./suss.mjs";

const pluginRoot =
  process.env.CLAUDE_PLUGIN_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectDir = process.cwd();

const server = findExecutable({
  pkg: "@suss/mcp",
  bin: "suss-mcp",
  projectDir,
  pluginRoot,
});
const child = spawn(server.command, [...server.prefix, projectDir], {
  stdio: "inherit",
  shell: server.shell,
});

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
child.on("exit", (code) => {
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  process.stderr.write(
    `[suss] could not start the MCP server: ${error.message}\n`,
  );
  process.exit(1);
});
