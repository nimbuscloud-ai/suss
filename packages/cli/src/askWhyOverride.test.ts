/**
 * A method a subclass overrides, asked about with `suss ask why`. The read
 * finds the subclass's own method and the one it inherits, and the answer
 * is the subclass's own, the same one the extractor follows.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-why-override-"));
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

describe("why a method a subclass overrides resolves to the subclass's own", () => {
  it("follows a Python subclass that writes its own save", () => {
    write("app/users.py", [
      "class Repository:",
      "    def save(self):",
      '        return "base"',
      "",
      "",
      "class Accounts(Repository):",
      "    def save(self):",
      '        return "accounts"',
      "",
      "",
      "def load():",
      "    accounts = Accounts()",
      "    return accounts.save()",
    ]);

    const { exitCode, text } = askWhy(
      "why does accounts.save at app/users.py:13 resolve to save",
    );

    expect(exitCode).toBe(0);
    expect(text).toContain("resolves to save (app/users.py:7)");
  });
});
