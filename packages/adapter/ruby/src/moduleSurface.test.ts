import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { boundaryKey } from "@suss/behavioral-ir";

import { settleRubyModules } from "./moduleSurface.js";
import { extractRubyProject } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const FILES: Record<string, string> = {
  "lib/billing.rb": [
    "module Billing",
    "  def self.charge_invoice(invoice_id)",
    "    Ledger.record(invoice_id)",
    "  end",
    "",
    "  class Invoice",
    "    def total",
    "      0",
    "    end",
    "",
    "    private",
    "",
    "    def audit",
    "      nil",
    "    end",
    "  end",
    "end",
    "",
  ].join("\n"),
  "lib/billing/ledger.rb": [
    "module Billing",
    "  module Ledger",
    "    def self.record(invoice_id)",
    "      invoice_id",
    "    end",
    "  end",
    "end",
    "",
  ].join("\n"),
  "lib/reports.rb": [
    "module Reports",
    "  def self.monthly",
    "    Billing.charge_invoice(1)",
    "  end",
    "end",
    "",
  ].join("\n"),
};

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-rb-module-surface-")),
  );
  for (const [file, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function extract(withModules: boolean): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: Object.keys(FILES).map((file) => path.join(root, file)),
    packs: [],
    workspaceRoot: root,
    cacheDir: null,
    ...(withModules
      ? { modules: [{ name: "billing", root: path.join(root, "lib/billing") }] }
      : {}),
  });
  return summaries;
}

function keys(summaries: readonly BehavioralSummary[]): string[] {
  return summaries
    .map((summary) =>
      summary.identity.boundaryBinding === null
        ? null
        : boundaryKey(summary.identity.boundaryBinding),
    )
    .filter((key): key is string => key !== null)
    .sort();
}

describe("a Ruby module's public exports", () => {
  it("finds the file named for the module next to its root", () => {
    const [billing] = settleRubyModules([
      { name: "billing", root: path.join(root, "lib/billing") },
    ]);
    expect(billing?.public).toEqual([path.join(root, "lib/billing.rb")]);
  });

  it("keys each class method and public instance method in the public file", async () => {
    expect(keys(await extract(true))).toEqual([
      "fn:billing::Billing.charge_invoice",
      "fn:billing::Billing::Invoice#total",
    ]);
  });

  it("stamps the module on its own files and leaves the others alone", async () => {
    const summaries = await extract(true);
    const record = summaries.find((s) => s.identity.name === "record");
    expect(record?.location.module).toBe("billing");
    const stamped = summaries
      .filter((s) => s.location.module !== undefined)
      .map((s) => s.location.file);
    expect(new Set(stamped)).toEqual(
      new Set(["lib/billing.rb", "lib/billing/ledger.rb"]),
    );
  });

  it("keys nothing and stamps nothing without a module list", async () => {
    const summaries = await extract(false);
    expect(keys(summaries)).toEqual([]);
    expect(summaries.every((s) => s.location.module === undefined)).toBe(true);
  });
});
