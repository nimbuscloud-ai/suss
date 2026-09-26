/**
 * A callback written onto an object through a name, `job.on_failure =
 * page_oncall`, and read back off the same name, asked about with `suss
 * ask why` in each language. The write lands on the object the name
 * refers to, so the read resolves to the callback. A write from a body
 * that does not declare the name runs at a time nothing orders against
 * the read, so it resolves nothing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { answerQuestion } from "./ask.js";
import { preloadWhySessions } from "./askWhy.js";

let dir: string;

beforeAll(async () => {
  await preloadWhySessions();
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-why-named-store-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(relPath: string, lines: string[]): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${lines.join("\n")}\n`);
}

function askWhy(question: string): { exitCode: number; text: string } {
  const output = path.join(dir, "answer.txt");
  const { exitCode } = answerQuestion({ question, project: dir, output });
  return { exitCode, text: fs.readFileSync(output, "utf8") };
}

describe("why a property written through a name resolves to what was written", () => {
  it("follows a Python attribute write on a module-level instance", () => {
    write("app/reports.py", [
      "class ReportJob:",
      "    def run(self):",
      '        return self.on_failure("failed")',
      "",
      "",
      "def page_oncall(message):",
      "    return message",
      "",
      "",
      "job = ReportJob()",
      "job.on_failure = page_oncall",
      "",
      "",
      "def retry():",
      '    return job.on_failure("retry")',
    ]);

    const { exitCode, text } = askWhy(
      "why does job.on_failure at app/reports.py:15 resolve to page_oncall",
    );

    expect(exitCode).toBe(0);
    expect(text).toContain("resolves to page_oncall (app/reports.py:6)");
    expect(text).toContain("reads on_failure off job (app/reports.py:10)");
  });

  it("leaves out a Python write made inside another function", () => {
    write("app/reports.py", [
      "class ReportJob:",
      "    pass",
      "",
      "",
      "def page_oncall(message):",
      "    return message",
      "",
      "",
      "job = ReportJob()",
      "",
      "",
      "def setup():",
      "    job.on_failure = page_oncall",
      "",
      "",
      "def retry():",
      '    return job.on_failure("retry")',
    ]);

    const { text } = askWhy(
      "why does job.on_failure at app/reports.py:17 resolve to page_oncall",
    );

    expect(text).toContain("cannot follow job.on_failure");
  });

  it("follows a TypeScript property write on a module-level instance", () => {
    write("src/reports.ts", [
      "class ReportJob {",
      "  onFailure?: (message: string) => string;",
      "}",
      "",
      "function pageOncall(message: string): string {",
      "  return message;",
      "}",
      "",
      "const job = new ReportJob();",
      "job.onFailure = pageOncall;",
      "",
      "export function retry(): string | undefined {",
      '  return job.onFailure?.("retry");',
      "}",
    ]);

    const { exitCode, text } = askWhy(
      "why does job.onFailure at src/reports.ts:13 resolve to pageOncall",
    );

    expect(exitCode).toBe(0);
    expect(text).toContain("resolves to pageOncall (src/reports.ts:5)");
    expect(text).toContain("reads onFailure off job (src/reports.ts:13)");
  });

  it("follows a Ruby setter written through a name", () => {
    write("app/reports.rb", [
      "class ReportJob",
      "  attr_accessor :on_failure",
      "end",
      "",
      "job = ReportJob.new",
      "job.on_failure = ->(message) { message }",
      'job.on_failure.call("retry")',
    ]);

    const { exitCode, text } = askWhy(
      "why does on_failure at app/reports.rb:7 resolve to ->(message) { message }",
    );

    expect(exitCode).toBe(0);
    expect(text).toContain("reads on_failure off job (app/reports.rb:5)");
  });
});
