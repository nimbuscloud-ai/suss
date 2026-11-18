/**
 * An app that serves one OpenAPI document and calls a service another
 * document describes, through a client generated from it, read in each
 * language with `extract --out-dir` and checked with `check --dir`.
 *
 * Each fixture serves two of the three operations in
 * `openapi/internal-v1.json`, so the third is reported as unimplemented.
 * Nothing serves `openapi/ledger.json`. In Ruby and Python nothing suss
 * reads calls it either, so the run gets one note naming the document.
 * The TypeScript client sends one request with a path suss reads, so
 * that document was compared and gets no note. None of its operations
 * is reported as unimplemented in any language.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

import type { Finding, RunFinding } from "@suss/behavioral-ir";

const FIXTURES = path.resolve(__dirname, "../../../fixtures/upstream-spec");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "suss-upstream-spec-"));

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

async function quietly(
  args: string[],
  cwd: string,
): Promise<{ exit: number; stdout: string }> {
  const out: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  const origCwd = process.cwd();
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.chdir(cwd);
  try {
    const exit = await runCli(args);
    return { exit, stdout: out.join("") };
  } finally {
    process.chdir(origCwd);
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

async function checked(
  fixture: string,
): Promise<{ findings: Finding[]; run: RunFinding[] }> {
  const project = path.join(work, fixture);
  fs.cpSync(path.join(FIXTURES, fixture), project, { recursive: true });
  const summaries = path.join(work, `${fixture}-summaries`);
  const extract = await quietly(["extract", "--out-dir", summaries], project);
  expect(extract.exit).toBe(0);
  const check = await quietly(["check", "--dir", summaries, "--json"], project);
  return JSON.parse(check.stdout) as { findings: Finding[]; run: RunFinding[] };
}

function unimplemented(findings: readonly Finding[]): string[] {
  return findings
    .filter((finding) => finding.kind === "contractOperationUnimplemented")
    .map((finding) => finding.description);
}

const ARCHIVE_UNIMPLEMENTED =
  "The openapi contract declares POST /api/v1/widgets/{id}/archive and no extracted provider implements it.";

describe.each(["rails", "fastapi"])(
  "a %s app with a document for a service it calls through a generated client",
  (fixture) => {
    it("reports only the served document's missing operation, and one note on the other", async () => {
      const { findings, run } = await checked(fixture);

      expect(unimplemented(findings)).toEqual([ARCHIVE_UNIMPLEMENTED]);
      const notes = run.filter((one) => one.kind === "contractUnpaired");
      expect(notes).toHaveLength(1);
      expect(notes[0]?.severity).toBe("info");
      expect(notes[0]?.description).toMatch(
        /^openapi\/ledger\.json declares 3 operations, and nothing in the code serves or calls any of them/,
      );
    });
  },
);

describe("an express app whose generated client sends a request suss reads", () => {
  it("reports only the served document's missing operation, with no note", async () => {
    const { findings, run } = await checked("express");

    expect(unimplemented(findings)).toEqual([ARCHIVE_UNIMPLEMENTED]);
    expect(run.filter((one) => one.kind === "contractUnpaired")).toEqual([]);
  });
});
