import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readSummaries } from "./summaryFile.js";
import { UsageError } from "./usageError.js";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

function fileWith(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-cli-summaries-"));
  dirs.push(dir);
  const file = path.join(dir, "summaries.json");
  fs.writeFileSync(file, text);
  return file;
}

function messageOf(read: () => unknown): string {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error("expected the read to fail");
}

describe("readSummaries", () => {
  it("says a file is invalid when inspect reads it", () => {
    const file = fileWith(JSON.stringify({ hello: 1 }));
    expect(messageOf(() => readSummaries(file))).toContain(
      `Invalid summary file ${file}:`,
    );
  });

  it("says what a file should have been when check reads it", () => {
    const file = fileWith(JSON.stringify({ hello: 1 }));
    expect(messageOf(() => readSummaries(file, "expectedOutput"))).toContain(
      "It should be the output of `suss extract` or `suss contract`",
    );
  });

  it("gives the first line of a parse error", () => {
    const file = fileWith("[\n{");
    expect(messageOf(() => readSummaries(file))).toMatch(
      /is not JSON suss can read: line 2: /,
    );
  });

  it("says a missing file cannot be read", () => {
    const file = path.join(os.tmpdir(), "suss-cli-no-such-summaries.json");
    expect(messageOf(() => readSummaries(file))).toContain("Could not read");
  });
});
