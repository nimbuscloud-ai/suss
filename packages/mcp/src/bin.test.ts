/**
 * The built binary, started the way a host starts it: a subprocess that
 * talks MCP over its stdin and stdout.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LIVE_RECORD } from "./liveSocket.js";

const BIN = path.resolve(__dirname, "../dist/bin.js");

const cleanups: Array<() => void> = [];

// Last added runs first, so a server is killed before the folders it
// writes into are removed.
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function projectWithOneRoute(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-bin-")),
  );
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src/app.ts"),
    [
      'import express from "express";',
      "const app = express();",
      'app.get("/orders", (req, res) => res.json([]));',
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ include: ["src"] }),
  );
  return root;
}

async function waitFor(condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`still waiting after ${ms} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("suss-mcp", () => {
  it("exits and gives up the socket when the host closes stdin without a signal", async () => {
    const root = projectWithOneRoute();
    const server = spawn(process.execPath, [BIN, root], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(() => server.kill("SIGKILL"));
    const exited = new Promise<number | null>((resolve) =>
      server.on("exit", (code) => resolve(code)),
    );
    const record = path.join(root, LIVE_RECORD);
    await waitFor(() => fs.existsSync(record), 30_000);
    const { socket } = JSON.parse(fs.readFileSync(record, "utf8")) as {
      socket: string;
    };

    server.stdin.end();
    const code = await Promise.race([
      exited,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("still running"), 10_000),
      ),
    ]);

    expect(code).toBe(0);
    expect(fs.existsSync(record)).toBe(false);
    expect(fs.existsSync(socket)).toBe(false);
  }, 60_000);

  it.each([
    { how: "the --cache-dir argument", viaArgument: true },
    { how: "SUSS_CACHE_DIR", viaArgument: false },
  ])(
    "writes its cache and live record under $how and nothing into the project",
    async ({ viaArgument }) => {
      const root = projectWithOneRoute();
      fs.writeFileSync(
        path.join(root, "suss.json"),
        JSON.stringify({
          version: 1,
          read: [
            {
              kind: "extract",
              language: "typescript",
              project: "tsconfig.json",
              packs: ["express"],
            },
          ],
        }),
      );
      const state = fs.mkdtempSync(path.join(os.tmpdir(), "suss-bin-state-"));
      cleanups.push(() => fs.rmSync(state, { recursive: true, force: true }));
      const args = viaArgument
        ? [BIN, root, "--cache-dir", state]
        : [BIN, root];
      const server = spawn(process.execPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: viaArgument
          ? process.env
          : { ...process.env, SUSS_CACHE_DIR: state },
      });
      cleanups.push(() => server.kill("SIGKILL"));
      const exited = new Promise<void>((resolve) =>
        server.on("exit", () => resolve()),
      );

      await waitFor(
        () =>
          fs.existsSync(path.join(state, "live")) &&
          fs.existsSync(path.join(state, "cache")),
        30_000,
      );
      server.stdin.end();
      // The server may still be writing its cache, and removing the
      // folder under it fails with ENOTEMPTY.
      await exited;

      expect(fs.existsSync(path.join(root, ".suss"))).toBe(false);
    },
    60_000,
  );
});
