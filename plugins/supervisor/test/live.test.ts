import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { askLiveServer } from "../scripts/live.mjs";
import { Session } from "../scripts/session.mjs";
import { runSuss } from "../scripts/suss.mjs";

let project: string;
let servers: net.Server[] = [];

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "suss-live-client-"));
});

afterEach(() => {
  for (const server of servers) {
    server.close();
  }
  servers = [];
  fs.rmSync(project, { recursive: true, force: true });
});

/** A stand-in for the MCP server: records each request and sends `reply`. */
function serve(reply: unknown): { asked: unknown[] } {
  const asked: unknown[] = [];
  const socket = path.join(project, "live.sock");
  const server = net.createServer((connection) => {
    let text = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("\n")) {
        asked.push(JSON.parse(text));
        connection.end(`${JSON.stringify(reply)}\n`);
      }
    });
  });
  server.listen(socket);
  servers.push(server);
  record(socket);
  return { asked };
}

function record(socket: string): void {
  fs.mkdirSync(path.join(project, ".suss", "live"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".suss", "live", "server.json"),
    JSON.stringify({ socket, pid: process.pid }),
  );
}

async function listening(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("asking the MCP server to run a command", () => {
  it("returns what the server printed, after sending it the arguments", async () => {
    const server = serve({ code: 0, stdout: "{}", stderr: "" });
    await listening();

    const run = await askLiveServer(
      project,
      ["extract", "--out-dir", "x"],
      5000,
    );

    expect(run).toEqual({ code: 0, stdout: "{}", stderr: "" });
    expect(server.asked).toEqual([
      { kind: "suss", args: ["extract", "--out-dir", "x"], cwd: project },
    ]);
  });

  it("returns null when no server has said where it listens", async () => {
    expect(await askLiveServer(project, ["extract"], 5000)).toBeNull();
  });

  it("returns null when the server that wrote the record has gone", async () => {
    record(path.join(project, "gone.sock"));

    expect(await askLiveServer(project, ["extract"], 5000)).toBeNull();
  });

  it("returns null for a command the server does not serve", async () => {
    serve({ unsupported: "the socket does not serve `inspect`" });
    await listening();

    expect(await askLiveServer(project, ["inspect"], 5000)).toBeNull();
  });

  it("tells the server when the edit it wants read was queued", async () => {
    const server = serve({ code: 0, stdout: "", stderr: "" });
    await listening();
    const session = new Session(project, "one");
    session.create();
    session.appendEdit({ tool: "Edit", file: "src/app.ts" });
    const queuedAt = session.editQueuedAt(1);

    await askLiveServer(project, ["extract"], 5000, queuedAt);

    expect(queuedAt).toBeGreaterThan(0);
    expect(server.asked).toEqual([
      { kind: "suss", args: ["extract"], cwd: project, notBefore: queuedAt },
    ]);
  });

  it("is what runSuss hands back when the server serves the command", async () => {
    serve({ code: 1, stdout: "", stderr: "failed\n" });
    await listening();
    const missing = {
      command: path.join(project, "no-such-suss"),
      prefix: [],
      from: "plugin" as const,
      version: null,
      shell: false,
    };

    const run = await runSuss(missing, ["extract", "--out-dir", "x"], {
      cwd: project,
      timeoutMs: 5000,
    });

    expect(run).toEqual({ code: 1, stdout: "", stderr: "failed\n" });
  });
});
