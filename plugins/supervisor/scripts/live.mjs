/**
 * Asking the suss MCP server to run a command, instead of starting the
 * CLI.
 *
 * The server keeps the project's program between edits, so a read after
 * an edit costs what the edit changed. The server that keeps it writes
 * `.suss/live/server.json` under the project with the path of its socket.
 * A request is the arguments the CLI would get, and the reply is what
 * the CLI would have printed. When no server is up, or it does not serve
 * the command, this returns null and the caller runs the CLI.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/** @typedef {import("./types.js").SussRun} SussRun */

/**
 * `notBefore` is when the latest change the caller wants read was made;
 * the server may hand back a build it started after that.
 *
 * @param {string} projectDir
 * @param {string[]} args
 * @param {number} timeoutMs
 * @param {number} [notBefore]
 * @returns {Promise<SussRun | null>}
 */
export async function askLiveServer(projectDir, args, timeoutMs, notBefore) {
  const socketPath = liveSocketOf(projectDir);
  if (socketPath === null) {
    return null;
  }
  const reply = await request(
    socketPath,
    {
      kind: "suss",
      args,
      cwd: projectDir,
      ...(notBefore === undefined ? {} : { notBefore }),
    },
    timeoutMs,
  );
  if (
    reply === null ||
    typeof reply.code !== "number" ||
    typeof reply.stdout !== "string" ||
    typeof reply.stderr !== "string"
  ) {
    return null;
  }
  return { code: reply.code, stdout: reply.stdout, stderr: reply.stderr };
}

/**
 * @param {string} projectDir
 * @returns {string | null}
 */
function liveSocketOf(projectDir) {
  try {
    const record = JSON.parse(
      fs.readFileSync(
        path.join(projectDir, ".suss", "live", "server.json"),
        "utf8",
      ),
    );
    return typeof record?.socket === "string" ? record.socket : null;
  } catch {
    return null;
  }
}

/**
 * One line of JSON out, one line back. Null when the server cannot be
 * reached, replies with something else, or takes longer than the budget.
 *
 * @param {string} socketPath
 * @param {unknown} body
 * @param {number} timeoutMs
 * @returns {Promise<Record<string, unknown> | null>}
 */
function request(socketPath, body, timeoutMs) {
  return new Promise((resolve) => {
    let buffered = "";
    const socket = net.connect(socketPath);
    /** @param {Record<string, unknown> | null} value */
    const done = (value) => {
      clearTimeout(deadline);
      socket.destroy();
      resolve(value);
    };
    const deadline = setTimeout(() => done(null), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on("data", (chunk) => {
      buffered += chunk;
    });
    socket.on("end", () => {
      try {
        done(JSON.parse(buffered));
      } catch {
        done(null);
      }
    });
    socket.on("error", () => done(null));
  });
}
