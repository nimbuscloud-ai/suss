/**
 * A method a TypeScript subclass inherits, called on a receiver with no
 * type, asked about with `suss ask why`. The type checker has nothing to
 * say about the receiver, so the rules find the method by walking from the
 * subclass to the base it extends.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-why-inherited-"));
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

describe("why a method a subclass inherits resolves to the base's", () => {
  it("follows a TypeScript subclass to the base it extends", () => {
    write("src/users.ts", [
      "class User {",
      "  save(): string {",
      '    return "saved";',
      "  }",
      "}",
      "",
      "class Admin extends User {}",
      "",
      "// biome-ignore lint: the receiver is untyped on purpose",
      "function persist(account) {",
      "  return account.save();",
      "}",
      "",
      "export function promote(): string {",
      "  return persist(new Admin());",
      "}",
    ]);

    const { exitCode, text } = askWhy(
      "why does account.save at src/users.ts:11 resolve to save",
    );

    expect(exitCode).toBe(0);
    expect(text).toContain("resolves to save (src/users.ts:2)");
    expect(text).toContain("which contains save (src/users.ts:2)");
  });
});
