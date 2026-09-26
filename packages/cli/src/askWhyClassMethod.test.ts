/**
 * `suss ask why` over a Ruby call whose method is not written as a plain
 * `def` in the class body. The answer follows the call to the method all
 * the same.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-why-class-method-"));
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

describe("why a Ruby call resolves to a method", () => {
  it("follows a call on the class to a method written inside `class << self`", () => {
    write("app/report_formatter.rb", [
      "class ReportFormatter",
      "  class << self",
      "    def shorten(entity)",
      "      entity",
      "    end",
      "  end",
      "end",
      "",
      "class OrderReport",
      "  def call(order)",
      "    ReportFormatter.shorten(order)",
      "  end",
      "end",
    ]);

    const { exitCode, text } = askWhy(
      "why does shorten at app/report_formatter.rb:11 resolve to shorten",
    );
    expect(exitCode).toBe(0);
    expect(text).toContain("resolves to shorten (app/report_formatter.rb:3)");
  });

  it.each(["private", "protected", "public"])(
    "follows a bare call to a method written as `%s def`",
    (modifier) => {
      write("app/order_report.rb", [
        "class OrderReport",
        "  def call(order)",
        "    totaled(order)",
        "  end",
        "",
        `  ${modifier} def totaled(order)`,
        "    order",
        "  end",
        "end",
      ]);

      const { exitCode, text } = askWhy(
        "why does totaled at app/order_report.rb:3 resolve to totaled",
      );
      expect(exitCode).toBe(0);
      expect(text).toContain("resolves to totaled (app/order_report.rb:6)");
    },
  );

  it("follows a call on a module to a method written as `module_function def`", () => {
    write("app/formats.rb", [
      "module Formats",
      "  module_function def wrap(entity)",
      "    entity",
      "  end",
      "end",
      "",
      "class OrderReport",
      "  def call(order)",
      "    Formats.wrap(order)",
      "  end",
      "end",
    ]);

    const { exitCode, text } = askWhy(
      "why does wrap at app/formats.rb:9 resolve to wrap",
    );
    expect(exitCode).toBe(0);
    expect(text).toContain("resolves to wrap (app/formats.rb:2)");
  });
});
