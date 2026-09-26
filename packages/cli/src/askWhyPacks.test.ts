/**
 * `suss ask why` over a Ruby method called on what an ActiveRecord finder
 * gave back. Only the activerecord pack says that `Order.find` gives back
 * an Order, so the answer follows the call to the model's method when the
 * project's `suss.json` lists the pack, and says why it cannot when the
 * pack does not load.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { answerQuestion, preloadForQuestion } from "./ask.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-why-packs-"));
  write("app/models/application_record.rb", [
    "class ApplicationRecord < ActiveRecord::Base",
    "  self.abstract_class = true",
    "end",
  ]);
  write("app/models/order.rb", [
    "class Order < ApplicationRecord",
    "  def cancel",
    "    update(status: :cancelled)",
    "  end",
    "end",
  ]);
  write("app/services/order_canceller.rb", [
    "class OrderCanceller",
    "  def call(id)",
    "    order = Order.find(id)",
    "    order.cancel",
    "  end",
    "end",
  ]);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(relPath: string, lines: string[]): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${lines.join("\n")}\n`);
}

function listPacks(packs: string[]): void {
  write("suss.json", [
    JSON.stringify({
      version: 1,
      read: [{ kind: "extract", language: "ruby", packs }],
    }),
  ]);
}

const QUESTION =
  "why does cancel at app/services/order_canceller.rb:4 resolve to app/models/order.rb:2";

async function askWhy(): Promise<{ exitCode: number; text: string }> {
  const output = path.join(dir, "answer.txt");
  const whyPacks = await preloadForQuestion(QUESTION, dir);
  const { exitCode } = answerQuestion({
    question: QUESTION,
    project: dir,
    output,
    ...(whyPacks !== undefined ? { whyPacks } : {}),
  });
  return { exitCode, text: fs.readFileSync(output, "utf8") };
}

describe("why a method called on what a finder gave back resolves to the model's method", () => {
  it("follows the call to the model when suss.json lists the pack that declares the finder", async () => {
    write("suss.activerecord.json", ['{ "storageSystem": "postgresql" }']);
    listPacks([`activerecord=${path.join(dir, "suss.activerecord.json")}`]);

    const { exitCode, text } = await askWhy();

    expect(exitCode).toBe(0);
    expect(text).toContain("resolves to cancel (app/models/order.rb:2)");
  });

  it("reads a relative config path in suss.json against the project root when asked from a subdirectory", async () => {
    write("suss.activerecord.json", ['{ "storageSystem": "postgresql" }']);
    listPacks(["activerecord=suss.activerecord.json"]);

    const before = process.cwd();
    process.chdir(path.join(dir, "app"));
    try {
      const { exitCode, text } = await askWhy();

      expect(text).not.toContain("did not load");
      expect(exitCode).toBe(0);
      expect(text).toContain("resolves to cancel (app/models/order.rb:2)");
    } finally {
      process.chdir(before);
    }
  });

  it("says the pack did not load when it cannot follow the call", async () => {
    listPacks(["activerecord"]);

    const { exitCode, text } = await askWhy();

    expect(exitCode).toBe(1);
    expect(text).toContain(
      "A Ruby step only activerecord declares is left out, because that pack did not load.",
    );
  });
});
