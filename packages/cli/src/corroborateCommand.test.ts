// corroborateCommand.test.ts — the `suss corroborate` CLI surface.
//
// The engine itself is covered in corroborate.test.ts; these tests
// exercise the command shell: flag gating, extraction wiring, the
// human report, the annotated-summaries output, and exit codes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

interface CapturedIO {
  stdout: string;
  stderr: string;
}

async function capture(fn: () => Promise<number>): Promise<{
  exit: number;
  io: CapturedIO;
}> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    stdoutChunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    stderrChunks.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  let exit: number;
  try {
    exit = await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return {
    exit,
    io: { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") },
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-corroborate-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

function writeHandlerProject(): void {
  const srcDir = path.join(tmpDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, "routes.ts"),
    `import { Router } from "express";
const router = Router();
router.get("/users", (req, res) => {
  if (!req.query.id) {
    res.status(400).json({ error: "missing" });
    return;
  }
  res.status(200).json({ id: req.query.id });
});
export default router;
`,
  );
  fs.writeFileSync(
    path.join(tmpDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, module: "esnext" },
      include: ["src"],
    }),
  );
}

describe("runCli — corroborate", () => {
  it("refuses to run without --experimental", async () => {
    const { exit, io } = await capture(() =>
      runCli(["corroborate", "-f", "express"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("--experimental");
  });

  it("rejects when no pack is given", async () => {
    const { exit, io } = await capture(() =>
      runCli(["corroborate", "--experimental"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("-f");
  });

  it("runs a handler against its own claims and writes annotated summaries", async () => {
    writeHandlerProject();
    const outFile = path.join(tmpDir, "out", "annotated.json");
    const { exit, io } = await capture(() =>
      runCli([
        "corroborate",
        "--experimental",
        "-p",
        path.join(tmpDir, "tsconfig.json"),
        "-f",
        "express",
        "--runs",
        "5",
        "-o",
        outFile,
      ]),
    );
    expect(exit).toBe(0);
    expect(io.stdout).toContain("GET /users");
    expect(io.stdout).toContain("held up");

    const written = JSON.parse(
      fs.readFileSync(outFile, "utf8"),
    ) as BehavioralSummary[];
    const handler = written.find((s) => s.kind === "handler");
    expect(handler).toBeDefined();
    const verdicts = (handler as BehavioralSummary).transitions
      .map((t) => t.confidence?.corroboration?.outcome)
      .filter((outcome) => outcome !== undefined);
    expect(verdicts).toContain("observed");
  });

  it("reports when nothing is in scope", async () => {
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, "consumer.ts"),
      `import axios from "axios";
export async function loadPet(id: string) {
  const res = await axios.get(\`/pets/\${id}\`);
  return res.data;
}
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, module: "esnext" },
        include: ["src"],
      }),
    );
    const { exit, io } = await capture(() =>
      runCli([
        "corroborate",
        "--experimental",
        "-p",
        path.join(tmpDir, "tsconfig.json"),
        "-f",
        "axios",
      ]),
    );
    expect(exit).toBe(0);
    expect(io.stdout).toContain("in scope");
  });
});

describe("runCli — corroborate flag validation", () => {
  it("rejects a --project path that does not exist", async () => {
    const { exit, io } = await capture(() =>
      runCli([
        "corroborate",
        "--experimental",
        "-f",
        "express",
        "-p",
        "/nope/tsconfig.json",
      ]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("tsconfig");
  });

  it("rejects a --dir path that does not exist", async () => {
    const { exit, io } = await capture(() =>
      runCli([
        "corroborate",
        "--experimental",
        "-f",
        "express",
        "--dir",
        "/nope/dir",
      ]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("No directory");
  });

  it("rejects non-positive --runs and --attempts", async () => {
    const bad = await capture(() =>
      runCli(["corroborate", "--experimental", "-f", "express", "--runs", "0"]),
    );
    expect(bad.exit).toBe(1);
    expect(bad.io.stderr).toContain("--runs");

    const worse = await capture(() =>
      runCli([
        "corroborate",
        "--experimental",
        "-f",
        "express",
        "--attempts=-3",
      ]),
    );
    expect(worse.exit).toBe(1);
    expect(worse.io.stderr).toContain("--attempts");
  });
});
