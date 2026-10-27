/**
 * A bare `suss extract` in a project whose `suss.json` lists reads in
 * two languages, as `suss init --write` writes it. Every read has to
 * run, and a read that fails has to be named without stopping the rest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseSummaries } from "@suss/behavioral-ir";
import { readSummaryFile } from "@suss/behavioral-ir/files";

import { runCli } from "./run.js";

const PYTHON = `from fastapi import FastAPI

app = FastAPI()


@app.get("/orders/{order_id}")
def get_order(order_id: str):
    return {"id": order_id}
`;

const TYPESCRIPT = `export async function orderTotal(id: string): Promise<number> {
  const res = await fetch(\`/orders/\${id}\`);
  return (await res.json()).total;
}
`;

const PYTHON_READ = {
  kind: "extract",
  language: "python",
  packs: ["fastapi"],
};

const TYPESCRIPT_READ = {
  kind: "extract",
  language: "typescript",
  dir: "frontend",
  packs: ["fetch"],
};

let project: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "suss-bare-extract-"));
  fs.mkdirSync(path.join(project, "app"));
  fs.writeFileSync(path.join(project, "app", "main.py"), PYTHON);
  fs.writeFileSync(path.join(project, "pyproject.toml"), "[project]\n");
  fs.mkdirSync(path.join(project, "frontend", "src"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "frontend", "src", "orders.ts"),
    TYPESCRIPT,
  );
  fs.writeFileSync(
    path.join(project, "frontend", "package.json"),
    '{ "name": "frontend" }\n',
  );
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe("a bare extract with several reads in suss.json", () => {
  it("reads the Python and the TypeScript entry into one array", async () => {
    writeReads([PYTHON_READ, TYPESCRIPT_READ]);

    const run = await quietly(["extract", "--dir", project]);

    expect(run.stderr).not.toContain("failed:");
    expect(run.exit).toBe(0);
    const languages = new Set(
      parseSummaries(JSON.parse(run.stdout)).map((summary) =>
        path.extname(summary.location.file),
      ),
    );
    expect(languages).toEqual(new Set([".py", ".ts"]));
  });

  it("writes the same array to -o", async () => {
    writeReads([PYTHON_READ, TYPESCRIPT_READ]);
    const out = path.join(project, "all.json");

    const run = await quietly(["extract", "--dir", project, "-o", out]);

    expect(run.exit).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toContain("suss-read-");
    expect(run.stderr).toContain(
      "suss extract --lang python -f fastapi: 1 summary",
    );
    expect(run.stderr).toMatch(/Wrote \d+ summaries to .*all\.json\n$/);
    const files = readSummaryFile(out).map((summary) => summary.location.file);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/main\.py$/),
        expect.stringMatching(/orders\.ts$/),
      ]),
    );
  });

  it("runs the other entries and exits 1 when one fails, saying which", async () => {
    writeReads([
      PYTHON_READ,
      { ...TYPESCRIPT_READ, packs: ["no-such-pack-anywhere"] },
    ]);

    const run = await quietly(["extract", "--dir", project]);

    expect(run.exit).toBe(1);
    expect(run.stderr).toMatch(
      /suss extract --lang typescript --dir frontend -f no-such-pack-anywhere: failed after .*\n {6}exited with code 1: Unknown pack: "no-such-pack-anywhere"/,
    );
    const files = parseSummaries(JSON.parse(run.stdout)).map(
      (summary) => summary.location.file,
    );
    expect(files).toEqual([expect.stringMatching(/main\.py$/)]);
  });

  it("refuses a flag the entries would ignore", async () => {
    writeReads([PYTHON_READ, TYPESCRIPT_READ]);

    const run = await quietly(["extract", "--dir", project, "--timing"]);

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain("--timing");
  });

  it("refuses the read limits on an extract of one read", async () => {
    writeReads([PYTHON_READ]);

    const run = await quietly([
      "extract",
      "--dir",
      project,
      "--jobs",
      "2",
      "--read-timeout",
      "5",
    ]);

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain(
      "--jobs, --read-timeout set how the reads suss.json lists run, and this extract runs one read in this process. Drop them",
    );
  });

  it("still reads just the named pack when -f is given", async () => {
    writeReads([PYTHON_READ, TYPESCRIPT_READ]);

    const run = await quietly([
      "extract",
      "--dir",
      path.join(project, "frontend"),
      "--lang",
      "typescript",
      "-f",
      "fetch",
    ]);

    expect(run.exit).toBe(0);
    expect(run.stderr).not.toContain("Reading what suss.json says");
  });
});

describe("a bare extract with one read in suss.json", () => {
  it("reads it and exits 0", async () => {
    writeReads([PYTHON_READ]);

    const run = await quietly(["extract", "--dir", project]);

    expect(run.exit).toBe(0);
    expect(run.stderr).toContain("Reading what suss.json says.");
    const files = parseSummaries(JSON.parse(run.stdout)).map(
      (summary) => summary.location.file,
    );
    expect(files).toEqual([expect.stringMatching(/main\.py$/)]);
  });

  it("exits 1 and says why when the one read fails", async () => {
    writeReads([{ ...PYTHON_READ, packs: ["no-such-pack-anywhere"] }]);

    const run = await quietly(["extract", "--dir", project]);

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain("no-such-pack-anywhere");
  });
});

function writeReads(read: object[]): void {
  fs.writeFileSync(
    path.join(project, "suss.json"),
    JSON.stringify({ version: 1, read }),
  );
}

async function quietly(
  args: string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await runCli(args);
    return { exit, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}
