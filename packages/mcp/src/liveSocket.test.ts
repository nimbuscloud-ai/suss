import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkDirectory } from "@suss/cli";

import { LIVE_RECORD, LiveSocket, socketPathFor } from "./liveSocket.js";
import { Project } from "./project.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function projectWithOneRoute(routePath: string): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-live-")),
  );
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  writeRoute(root, routePath);
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", strict: true },
      include: ["src"],
    }),
  );
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
  return root;
}

function writeRoute(root: string, routePath: string): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src/app.ts"),
    [
      'import express from "express";',
      "const app = express();",
      `app.get("${routePath}", (req, res) => {`,
      "  res.status(200).json({ ok: true });",
      "});",
    ].join("\n"),
  );
}

/** A socket path short enough for every platform's limit. */
function socketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-sock-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "live.sock");
}

async function open(
  root: string,
  at: string,
): Promise<{
  project: Project;
  live: LiveSocket;
}> {
  const project = new Project({ root, watch: false });
  const live = await LiveSocket.open(project, at);
  cleanups.push(() => {
    live.close();
    project.close();
  });
  return { project, live };
}

function ask(at: string, body: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let text = "";
    const socket = net.connect(at);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("end", () => resolve(JSON.parse(text)));
    socket.on("error", reject);
  });
}

function routesIn(dir: string): string[] {
  return JSON.parse(
    fs.readFileSync(path.join(dir, "0-extract.json"), "utf8"),
  ).map(
    (summary: {
      identity: { boundaryBinding: { semantics: { path?: string } } };
    }) => summary.identity.boundaryBinding.semantics.path,
  );
}

describe("socketPathFor", () => {
  it("gives every server for one root the same path, and another root another", () => {
    expect(socketPathFor("/work/orders")).toBe(socketPathFor("/work/orders"));
    expect(socketPathFor("/work/orders")).not.toBe(
      socketPathFor("/work/invoices"),
    );
  });
});

describe("LiveSocket", () => {
  it("takes the socket when nobody has it and says where it is", async () => {
    const root = projectWithOneRoute("/orders");
    const at = socketPath();
    const { live } = await open(root, at);

    expect(live.owner).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, LIVE_RECORD), "utf8")),
    ).toEqual({ socket: at, pid: process.pid });
  });

  it("serves extract --out-dir with what the tree says now", async () => {
    const root = projectWithOneRoute("/orders");
    const at = socketPath();
    await open(root, at);
    const out = path.join(root, ".suss", "next");

    const first = await ask(at, {
      kind: "suss",
      args: ["extract", "--out-dir", out],
      cwd: root,
    });
    expect(first).toMatchObject({ code: 0, stdout: "" });
    expect(routesIn(out)).toEqual(["/orders"]);

    writeRoute(root, "/invoices");
    await ask(at, {
      kind: "suss",
      args: ["extract", "--out-dir", out],
      cwd: root,
    });
    expect(routesIn(out)).toEqual(["/invoices"]);
  }, 60_000);

  it("serves check --since --json with the report the CLI prints", async () => {
    const root = projectWithOneRoute("/orders");
    const at = socketPath();
    await open(root, at);
    const before = path.join(root, ".suss", "before");
    const after = path.join(root, ".suss", "after");
    await ask(at, {
      kind: "suss",
      args: ["extract", "--out-dir", before],
      cwd: root,
    });
    writeRoute(root, "/invoices");
    await ask(at, {
      kind: "suss",
      args: ["extract", "--out-dir", after],
      cwd: root,
    });

    const reply = await ask(at, {
      kind: "suss",
      args: ["check", "--dir", after, "--since", before, "--json"],
      cwd: root,
    });
    const report = JSON.parse(String(reply.stdout));

    expect(report.since).toBe(before);
    expect(Array.isArray(report.findings)).toBe(true);
    expect(report.changedBoundaries.length).toBeGreaterThan(0);
  }, 60_000);

  it("reads the folder it wrote ahead of the compare that follows", async () => {
    const root = projectWithOneRoute("/orders");
    const at = socketPath();
    await open(root, at);
    const out = path.join(root, ".suss", "next");
    await ask(at, {
      kind: "suss",
      args: ["extract", "--out-dir", out],
      cwd: root,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const reads = vi.spyOn(fs, "readFileSync");
    try {
      checkDirectory({ dir: out });
      const summaryReads = reads.mock.calls.filter(([file]) =>
        String(file).startsWith(out),
      );
      expect(summaryReads).toEqual([]);
    } finally {
      reads.mockRestore();
    }
  }, 60_000);

  it("says a command it does not serve is unsupported, so the hook runs the CLI", async () => {
    const root = projectWithOneRoute("/orders");
    const at = socketPath();
    await open(root, at);

    expect(
      await ask(at, { kind: "suss", args: ["inspect", "--diff"], cwd: root }),
    ).toHaveProperty("unsupported");
    expect(
      await ask(at, {
        kind: "suss",
        args: ["extract", "--out-dir", path.join(root, "x")],
        cwd: os.tmpdir(),
      }),
    ).toHaveProperty("unsupported");
  });

  it("has the first server build for a second one, which keeps no program", async () => {
    const root = projectWithOneRoute("/orders");
    const at = socketPath();
    await open(root, at);
    const { project, live } = await open(root, at);

    fs.writeFileSync(path.join(project.summaryDir, "1-contract.json"), "[]");
    const report = await project.start();

    expect(live.owner).toBe(false);
    expect(report.configured).toBe(true);
    expect(routesIn(project.summaryDir)).toEqual(["/orders"]);
    expect(fs.readdirSync(project.summaryDir)).toEqual(["0-extract.json"]);
    expect(project.keptAdapters()).toBe(0);
  }, 60_000);

  it("takes a socket file whose server has gone", async () => {
    const root = projectWithOneRoute("/orders");
    const at = socketPath();
    fs.writeFileSync(at, "");

    const { live } = await open(root, at);

    expect(live.owner).toBe(true);
  });

  it("reads a request that arrives in pieces, and says when one is not JSON", async () => {
    const root = projectWithOneRoute("/orders");
    const at = socketPath();
    await open(root, at);

    const pieces = await new Promise<string>((resolve) => {
      let text = "";
      const socket = net.connect(at);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write('{"kind":"suss",');
        setTimeout(() => socket.write('"args":["inspect"],"cwd":"/"}\n'), 50);
      });
      socket.on("data", (chunk: string) => {
        text += chunk;
      });
      socket.on("end", () => resolve(text));
    });
    const broken = await new Promise<string>((resolve) => {
      let text = "";
      const socket = net.connect(at);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write("not json\n"));
      socket.on("data", (chunk: string) => {
        text += chunk;
      });
      socket.on("end", () => resolve(text));
    });

    expect(JSON.parse(pieces)).toHaveProperty("unsupported");
    expect(JSON.parse(broken)).toMatchObject({ code: 1 });
  });

  it("says which arguments it serves when a request has others", async () => {
    const root = projectWithOneRoute("/orders");
    const at = socketPath();
    await open(root, at);

    expect(
      await ask(at, { kind: "suss", args: ["extract"], cwd: root }),
    ).toHaveProperty("unsupported");
    expect(
      await ask(at, {
        kind: "suss",
        args: ["extract", "--out-dir", root, "--files", "x.ts"],
        cwd: root,
      }),
    ).toHaveProperty("unsupported");
    expect(
      await ask(at, {
        kind: "suss",
        args: ["check", "--dir", root],
        cwd: root,
      }),
    ).toHaveProperty("unsupported");
  });

  it("fails the way the CLI does when a read fails or a folder is missing", async () => {
    const root = projectWithOneRoute("/orders");
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
          { kind: "contract", from: "openapi", file: "missing.yaml" },
        ],
      }),
    );
    const at = socketPath();
    await open(root, at);

    const extracted = await ask(at, {
      kind: "suss",
      args: ["extract", "--out-dir", path.join(root, ".suss", "next")],
      cwd: root,
    });
    const checked = await ask(at, {
      kind: "suss",
      args: ["check", "--dir", "nowhere", "--since", "nowhere", "--json"],
      cwd: root,
    });

    expect(extracted).toMatchObject({ code: 1 });
    expect(String(extracted.stderr)).toContain("missing.yaml");
    expect(checked).toMatchObject({ code: 1, stdout: "" });
  }, 60_000);

  it("fails a read that wrote no summary unless the request allows it", async () => {
    const root = projectWithOneRoute("/orders");
    fs.writeFileSync(path.join(root, "src/app.ts"), "export const x = 1;\n");
    const at = socketPath();
    await open(root, at);
    const out = path.join(root, ".suss", "next");

    const failing = await ask(at, {
      kind: "suss",
      args: ["extract", "--out-dir", out],
      cwd: root,
    });
    const allowed = await ask(at, {
      kind: "suss",
      args: ["extract", "--out-dir", out, "--allow-empty"],
      cwd: root,
    });

    expect(failing).toMatchObject({ code: 1 });
    expect(String(failing.stderr)).toContain("--allow-empty");
    expect(allowed).toMatchObject({ code: 0, stderr: "" });
  }, 60_000);

  it("says a project no pack matches has nothing to read", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "suss-live-bare-")),
    );
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const at = socketPath();
    await open(root, at);

    const reply = await ask(at, {
      kind: "suss",
      args: ["extract", "--out-dir", path.join(root, "out")],
      cwd: root,
    });

    expect(reply).toMatchObject({ code: 1 });
    expect(String(reply.stderr)).toContain("matched a pack");
  });

  it("takes the socket over when the first server has gone", async () => {
    const root = projectWithOneRoute("/orders");
    const at = socketPath();
    const first = await open(root, at);
    const second = await open(root, at);
    first.live.close();

    await second.project.build();

    expect(second.live.owner).toBe(true);
  }, 60_000);
});
