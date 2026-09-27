/**
 * The local socket the supervisor plugin's hooks talk to.
 *
 * One server per repository keeps the programs. The first to start
 * listens on a socket whose path comes from the repository root, and
 * writes that path to `.suss/live/server.json` for a hook to find. A
 * server that starts later has the first one build for it, and takes
 * the socket over if the first one goes away.
 *
 * A request is one line of JSON and so is the reply. A hook sends the
 * arguments it would give the CLI and gets back what the CLI would have
 * printed. A command the socket does not serve comes back `unsupported`,
 * and the hook runs the CLI instead.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { checkDir, clearEarlierReads } from "@suss/cli";

import type { BuildReport, Project } from "./project.js";

/** Where the server that keeps the programs says how to reach it. */
export const LIVE_RECORD = path.join(".suss", "live", "server.json");

/**
 * `notBefore` is when the caller knew the tree had its latest change, in
 * milliseconds since the epoch. A build that started after it is reused.
 */
export type LiveRequest =
  | { kind: "read"; outDir: string }
  | { kind: "suss"; args: string[]; cwd: string; notBefore?: number };

/** What the CLI would have printed, or why the socket does not serve it. */
export type SussReply =
  | { code: number; stdout: string; stderr: string }
  | { unsupported: string };

/** The socket's path for a repository root, the same in every server. */
export function socketPathFor(root: string): string {
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 16);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\suss-${digest}`;
  }
  return path.join(os.tmpdir(), `suss-${digest}.sock`);
}

export class LiveSocket {
  private server: net.Server | null = null;
  private closed = false;

  private constructor(
    private readonly project: Project,
    private readonly socketPath: string,
  ) {}

  /** Takes the socket, or has the server listening on it build for this one. */
  static async open(
    project: Project,
    socketPath: string = socketPathFor(project.root),
  ): Promise<LiveSocket> {
    const live = new LiveSocket(project, socketPath);
    if (!(await live.takeOver())) {
      project.buildElsewhere((summaryDir) => live.readThroughOwner(summaryDir));
    }
    return live;
  }

  /** Whether this server keeps the programs and replies to the hooks. */
  get owner(): boolean {
    return this.server !== null;
  }

  close(): void {
    this.closed = true;
    if (this.server === null) {
      return;
    }
    this.server.close();
    this.server = null;
    const record = path.join(this.project.root, LIVE_RECORD);
    if (readRecord(record)?.pid === process.pid) {
      fs.rmSync(record, { force: true });
    }
    if (process.platform !== "win32") {
      fs.rmSync(this.socketPath, { force: true });
    }
  }

  /**
   * Listens on the socket. A socket file whose server is gone is removed
   * and taken; one whose server replies is left alone.
   */
  private async takeOver(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    this.server = await listens(this.socketPath, this.handler());
    if (this.server === null && !(await replies(this.socketPath))) {
      if (process.platform !== "win32") {
        fs.rmSync(this.socketPath, { force: true });
      }
      this.server = await listens(this.socketPath, this.handler());
    }
    if (this.server === null) {
      return false;
    }
    this.becameOwner();
    return true;
  }

  private becameOwner(): void {
    this.project.buildElsewhere(null);
    const record = path.join(this.project.root, LIVE_RECORD);
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(record), ".gitignore"), "*\n");
    const temporary = `${record}.${process.pid}`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({ socket: this.socketPath, pid: process.pid }),
    );
    fs.renameSync(temporary, record);
  }

  /**
   * The owner's build, copied into this server's directory. When the
   * owner is gone this server takes the socket and builds for itself.
   */
  private async readThroughOwner(
    summaryDir: string,
  ): Promise<BuildReport | null> {
    const reply = await request(this.socketPath, {
      kind: "read",
      outDir: summaryDir,
    });
    if (reply !== null && "report" in reply) {
      return reply.report as BuildReport;
    }
    await this.takeOver();
    return null;
  }

  private handler(): (socket: net.Socket) => void {
    return (socket) => {
      let buffered = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffered += chunk;
        const end = buffered.indexOf("\n");
        if (end === -1) {
          return;
        }
        void this.answer(buffered.slice(0, end)).then(
          (reply) => socket.end(`${JSON.stringify(reply)}\n`),
          (error: unknown) =>
            socket.end(
              `${JSON.stringify({ code: 1, stdout: "", stderr: `${messageOf(error)}\n` })}\n`,
            ),
        );
      });
      socket.on("error", () => undefined);
    };
  }

  private async answer(line: string): Promise<unknown> {
    const asked = JSON.parse(line) as LiveRequest;
    if (asked.kind === "read") {
      const report = await this.project.buildNow();
      copyReads(this.project.summaryDir, asked.outDir);
      return { report };
    }
    return await serveCommand(this.project, asked);
  }
}

type SussRequest = Extract<LiveRequest, { kind: "suss" }>;

/** The commands the socket serves, keyed by the CLI's command word. */
const COMMANDS: Record<
  string,
  (project: Project, args: string[], asked: SussRequest) => Promise<SussReply>
> = {
  extract: extractIntoDirectory,
  check: checkSince,
};

export async function serveCommand(
  project: Project,
  asked: SussRequest,
): Promise<SussReply> {
  const [command, ...rest] = asked.args;
  const serve = command === undefined ? undefined : COMMANDS[command];
  if (serve === undefined) {
    return { unsupported: `the socket does not serve \`${command}\`` };
  }
  return await serve(project, rest, asked);
}

/**
 * `suss extract --out-dir <dir>`: brings the project up to date and
 * copies what each read of `suss.json` wrote, the files the CLI would
 * write there, with the same exit code.
 */
async function extractIntoDirectory(
  project: Project,
  args: string[],
  { cwd, notBefore }: SussRequest,
): Promise<SussReply> {
  const parsed = parsedOrNull(args, {
    "out-dir": { type: "string" },
    dir: { type: "string" },
    "allow-empty": { type: "boolean" },
  });
  const outDir = parsed?.values["out-dir"];
  if (parsed === null || typeof outDir !== "string") {
    return { unsupported: "the socket serves only extract --out-dir" };
  }
  const dir = parsed.values.dir;
  const root = realPath(path.resolve(cwd, typeof dir === "string" ? dir : ""));
  if (root !== project.root) {
    return { unsupported: `this server reads ${project.root}, not ${root}` };
  }

  const report = await project.buildNow(notBefore);
  if (report.ran.length + report.failed.length === 0) {
    return {
      code: 1,
      stdout: "",
      stderr: `Nothing in ${root} matched a pack, so there is nothing to read.\n`,
    };
  }
  const target = path.resolve(cwd, outDir);
  clearEarlierReads(target);
  copyReads(project.summaryDir, target);
  const allowEmpty = parsed.values["allow-empty"] === true;
  const stderr = [
    ...report.failed.map((line) => `  failed: ${line}`),
    ...(allowEmpty ? [] : report.empty).map(
      (command) =>
        `Failing because \`${command}\` didn't produce any summaries. Pass --allow-empty when that is expected.`,
    ),
  ];
  const failing =
    report.failed.length > 0 || (!allowEmpty && report.empty.length > 0);
  return {
    code: failing ? 1 : 0,
    stdout: "",
    stderr: stderr.map((line) => `${line}\n`).join(""),
  };
}

/** `suss check --dir <dir> --since <earlier> --json`, run in this process. */
async function checkSince(
  _project: Project,
  args: string[],
  { cwd }: SussRequest,
): Promise<SussReply> {
  const parsed = parsedOrNull(args, {
    dir: { type: "string" },
    since: { type: "string" },
    json: { type: "boolean" },
  });
  const dir = parsed?.values.dir;
  const since = parsed?.values.since;
  if (
    typeof dir !== "string" ||
    typeof since !== "string" ||
    parsed?.values.json !== true
  ) {
    return {
      unsupported: "the socket serves only check --dir --since --json",
    };
  }

  // The report goes to a file, since this process's stdout is the MCP
  // transport.
  const output = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-live-")),
    "report.json",
  );
  try {
    const result = checkDir({
      dir: path.resolve(cwd, dir),
      since: path.resolve(cwd, since),
      json: true,
      output,
    });
    return {
      code: result.hasErrors ? 1 : 0,
      stdout: fs.readFileSync(output, "utf8"),
      stderr: "",
    };
  } catch (error) {
    return { code: 1, stdout: "", stderr: `${messageOf(error)}\n` };
  } finally {
    fs.rmSync(path.dirname(output), { recursive: true, force: true });
  }
}

/** What a read of `suss.json` writes: `<n>-<kind>.json` and its notes. */
const READ_OUTPUT = /^\d+-(extract|contract)\./;

function copyReads(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (READ_OUTPUT.test(name)) {
      fs.copyFileSync(
        path.join(from, name),
        path.join(to, name),
        fs.constants.COPYFILE_FICLONE,
      );
    }
  }
}

type ArgOptions = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

function parsedOrNull(
  args: string[],
  options: ArgOptions,
): ReturnType<typeof parseArgs> | null {
  try {
    return parseArgs({ args, options, allowPositionals: false });
  } catch {
    return null;
  }
}

function listens(
  socketPath: string,
  handler: (socket: net.Socket) => void,
): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer(handler);
    server.once("error", () => resolve(null));
    server.listen(socketPath, () => {
      server.unref();
      resolve(server);
    });
  });
}

/** Whether a server replies on the socket at all. */
async function replies(socketPath: string): Promise<boolean> {
  const reply = await request(
    socketPath,
    { kind: "suss", args: ["status"], cwd: "/" },
    2000,
  );
  return reply !== null;
}

function request(
  socketPath: string,
  body: LiveRequest,
  timeoutMs?: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let buffered = "";
    const socket = net.connect(socketPath);
    const done = (value: Record<string, unknown> | null): void => {
      socket.destroy();
      resolve(value);
    };
    if (timeoutMs !== undefined) {
      socket.setTimeout(timeoutMs, () => done(null));
    }
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on("data", (chunk: string) => {
      buffered += chunk;
    });
    socket.on("end", () => {
      try {
        done(JSON.parse(buffered) as Record<string, unknown>);
      } catch {
        done(null);
      }
    });
    socket.on("error", () => done(null));
  });
}

function readRecord(file: string): { pid?: number } | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number };
  } catch {
    return null;
  }
}

function realPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
