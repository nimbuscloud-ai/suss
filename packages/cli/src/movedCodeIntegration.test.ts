/**
 * Code that moves without changing must read as unchanged. Each language
 * copies its two-module fixture, adds a unit that prints and writes the
 * accounts table, extracts, puts ten blank lines above that unit,
 * extracts again, and compares the two runs with `diffSummaries` and
 * `inspect --diff`. The unit prints the same thing twice. TypeScript
 * puts each print on its own path, so the second one's group id is
 * numbered, and Python and Ruby list both prints on every path, where
 * they fold into one effect with a count. In Ruby a module function and
 * an included instance method share a name, so their ids are numbered
 * too, and the lines also go above that pair.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { diffSummaries } from "@suss/behavioral-ir";
import { readSummaryFile } from "@suss/behavioral-ir/files";

import { runCli } from "./run.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const fixtures = path.resolve(__dirname, "../../../fixtures");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "suss-moved-"));

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Runs the CLI in this process and returns what it printed on stdout. */
async function suss(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return { code: await runCli(argv), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

interface Language {
  readonly fixture: string;
  readonly extract: (root: string) => string[];
  /** Files the test writes into the copy, by path from its root. */
  readonly files: Record<string, string>;
  /** Each file the blank lines go into, and the line they go above. */
  readonly moved: ReadonlyArray<{ file: string; above: string }>;
  readonly unit: string;
  /** An id that has to be numbered for two units to stay apart. */
  readonly settled?: string;
}

const LANGUAGES: Record<string, Language> = {
  TypeScript: {
    fixture: "modules-typescript",
    extract: (root) => [
      "-f",
      "pg",
      "-f",
      "node",
      "--dir",
      path.join(root, "src"),
    ],
    files: {
      "src/billing/notify.ts": `import { pool } from "../db.js";

export async function notifyAccount(id: string, loud: boolean): Promise<string> {
  if (loud) {
    console.warn("notifying", id);
    await pool.query("UPDATE accounts SET notified = true WHERE id = $1", [id]);
    return "loud";
  }
  console.warn("notifying", id);
  process.stderr.write("quiet\\n");
  await pool.query("UPDATE accounts SET notified = true WHERE id = $1", [id]);
  return "quiet";
}
`,
    },
    moved: [
      {
        file: "src/billing/notify.ts",
        above: "export async function notifyAccount",
      },
    ],
    unit: "notifyAccount",
  },
  Python: {
    fixture: "modules-python",
    extract: (root) => [
      "-f",
      `sqlalchemy=${path.join(root, "suss.sqlalchemy.json")}`,
      "--dir",
      root,
    ],
    files: {
      "app/billing/__init__.py": `from .charge import charge_invoice
from .notify import notify_account
`,
      "app/billing/notify.py": `import sys

from sqlalchemy import text


def notify_account(pool, account_id, loud):
    if loud:
        print("notifying", account_id, file=sys.stderr)
        pool.execute(text("UPDATE accounts SET notified = true WHERE id = :id"), {"id": account_id})
        return "loud"
    print("notifying", account_id, file=sys.stderr)
    print("quiet")
    pool.execute(text("UPDATE accounts SET notified = true WHERE id = :id"), {"id": account_id})
    return "quiet"
`,
    },
    moved: [{ file: "app/billing/notify.py", above: "def notify_account" }],
    unit: "notify_account",
  },
  Ruby: {
    fixture: "modules-ruby",
    extract: (root) => ["-f", "pg-ruby", "--dir", root],
    files: {
      "lib/flags.rb": `module Flags
  def self.on?
    ENV["NOTIFY"] == "1"
  end

  def on?
    Flags.on?
  end
end
`,
      "lib/billing.rb": `require "pg"
require_relative "billing/invoice_store"
require_relative "flags"

module Billing
  class Gate
    include Flags

    def open?
      on?
    end
  end

  def self.charge_invoice(invoice_id)
    conn = PG.connect(ENV["DATABASE_URL"])
    conn.exec_params(
      "UPDATE accounts SET balance = balance - 1 WHERE invoice_id = $1",
      [invoice_id]
    )
    InvoiceStore.save(invoice_id)
    "charged"
  end

  def self.notify_account(id, loud)
    return "off" unless Gate.new.open? && Flags.on?

    conn = PG.connect(ENV["DATABASE_URL"])
    if loud
      warn "notifying #{id}"
      conn.exec_params("UPDATE accounts SET notified = true WHERE id = $1", [id])
      return "loud"
    end
    warn "notifying #{id}"
    puts "quiet"
    conn.exec_params("UPDATE accounts SET notified = true WHERE id = $1", [id])
    "quiet"
  end
end
`,
    },
    moved: [
      { file: "lib/billing.rb", above: "  def self.notify_account" },
      { file: "lib/flags.rb", above: "  def self.on?" },
    ],
    unit: "notify_account",
    settled: "lib/flags.rb::Flags.on?#null@2",
  },
};

async function extractTo(
  language: Language,
  root: string,
  out: string,
): Promise<BehavioralSummary[]> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const { code } = await suss([
    "extract",
    ...language.extract(root),
    "--no-cache",
    "-o",
    out,
  ]);
  expect(code).toBe(0);
  return readSummaryFile(out);
}

function writesOf(summary: BehavioralSummary) {
  return summary.transitions.flatMap((transition) =>
    transition.effects.flatMap((effect) =>
      effect.type === "interaction" && effect.groupId !== undefined
        ? [{ groupId: effect.groupId, count: effect.count ?? 1 }]
        : [],
    ),
  );
}

function moveDown(root: string, spot: { file: string; above: string }): void {
  const at = path.join(root, spot.file);
  const text = fs.readFileSync(at, "utf8");
  expect(text).toContain(spot.above);
  fs.writeFileSync(
    at,
    text.replace(spot.above, `${"\n".repeat(10)}${spot.above}`),
  );
}

for (const [name, language] of Object.entries(LANGUAGES)) {
  describe(`code moved down ten lines in ${name}`, () => {
    it("reads as unchanged to diffSummaries and inspect --diff", async () => {
      const root = path.join(scratch, name);
      fs.cpSync(path.join(fixtures, language.fixture), root, {
        recursive: true,
      });
      for (const [file, text] of Object.entries(language.files)) {
        fs.writeFileSync(path.join(root, file), text);
      }
      const beforeFile = path.join(scratch, `${name}-before`, "code.json");
      const afterFile = path.join(scratch, `${name}-after`, "code.json");
      const before = await extractTo(language, root, beforeFile);
      for (const spot of language.moved) {
        moveDown(root, spot);
      }
      const after = await extractTo(language, root, afterFile);

      const unitOf = (run: BehavioralSummary[]) =>
        run.find((s) => s.identity.name.endsWith(language.unit));
      expect(unitOf(after)?.location.range.start).toBe(
        (unitOf(before)?.location.range.start ?? 0) + 10,
      );
      const writes = writesOf(unitOf(after) as BehavioralSummary);
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every((one) => !/\d+:\d+/.test(one.groupId))).toBe(true);
      expect(
        writes.some((one) => one.groupId.endsWith("#2") || one.count === 2),
      ).toBe(true);
      if (language.settled !== undefined) {
        expect(after.map((s) => s.identity.id)).toContain(language.settled);
      }

      const beforeById = new Map(before.map((s) => [s.identity.id, s]));
      expect(after.map((s) => s.identity.id).sort()).toEqual(
        [...beforeById.keys()].sort(),
      );
      for (const summary of after) {
        const was = beforeById.get(summary.identity.id) as BehavioralSummary;
        expect(diffSummaries(was, summary)).toEqual({
          addedTransitions: [],
          removedTransitions: [],
          changedTransitions: [],
        });
      }

      const printed = await suss(["inspect", "--diff", beforeFile, afterFile]);
      expect(printed.out).toBe("No behavioral changes.\n");
    }, 120_000);
  });
}
