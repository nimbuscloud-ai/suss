/**
 * `suss ask why` over a method called on a name assigned inside a
 * function, in each language. The answer describes the local by its name
 * and the line it is written on, the same way it describes a name
 * assigned at the top of a file.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-why-local-"));
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

/** A key the facts use for a name written inside a function, such as `app/orders.rb:20-75#closer`. */
const RAW_LOCAL_KEY = /:\d+-\d+#\w+/;

describe("why a method called on a local resolves to it", () => {
  it("describes a Ruby local by its name and the line it is written on", () => {
    write("app/orders.rb", [
      "class ReportCloser",
      "  def close",
      "    1",
      "  end",
      "end",
      "",
      "class OrderCloser",
      "  def call",
      "    closer = ReportCloser.new",
      "    closer.close",
      "  end",
      "end",
    ]);

    const { exitCode, text } = askWhy(
      "why does close at app/orders.rb:10 resolve to close",
    );
    expect(exitCode).toBe(0);
    expect(text).toContain("resolves to close (app/orders.rb:2)");
    expect(text).toContain("closer (app/orders.rb:9)");
    expect(text).not.toMatch(RAW_LOCAL_KEY);
  });

  it("describes a Python local and a Python parameter by name and line", () => {
    write("app/orders.py", [
      "class ReportCloser:",
      "    def close(self):",
      "        return 1",
      "",
      "",
      "def close_order():",
      "    closer = ReportCloser()",
      "    return closer.close()",
      "",
      "",
      "def close_with(closer):",
      "    return closer.close()",
      "",
      "",
      "close_with(ReportCloser())",
    ]);

    const local = askWhy(
      "why does closer.close at app/orders.py:8 resolve to close",
    );
    expect(local.exitCode).toBe(0);
    expect(local.text).toContain("resolves to close (app/orders.py:2)");
    expect(local.text).toContain("closer (app/orders.py:7)");
    expect(local.text).not.toMatch(RAW_LOCAL_KEY);

    const parameter = askWhy(
      "why does closer.close at app/orders.py:12 resolve to close",
    );
    expect(parameter.exitCode).toBe(0);
    expect(parameter.text).toContain("closer (app/orders.py:11)");
    expect(parameter.text).not.toMatch(RAW_LOCAL_KEY);
  });

  it("describes a TypeScript local by its name and the line it is written on", () => {
    write("src/orders.ts", [
      "function closeReport(): number {",
      "  return 1;",
      "}",
      "",
      "export function closeOrder(): number {",
      "  const closer = closeReport;",
      "  return closer();",
      "}",
    ]);

    const { exitCode, text } = askWhy(
      "why does closer at src/orders.ts:7 resolve to closeReport",
    );
    expect(exitCode).toBe(0);
    expect(text).toContain("resolves to closeReport (src/orders.ts:1)");
    expect(text).toContain("closer (src/orders.ts:6)");
    expect(text).not.toMatch(RAW_LOCAL_KEY);
  });
});
