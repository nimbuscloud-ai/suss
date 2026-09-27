/**
 * An application with two modules listed in `suss.json`, in each of the
 * three languages, run through the commands a user types: extract before
 * and after an edit, `inspect --diff`, `suss ask`, and for TypeScript
 * `check --intent` with a PRD that links to a module export's outcome.
 *
 * Each fixture has a billing module whose public export writes the
 * shared accounts table and calls a private helper that writes the
 * invoices table, and a catalog module that writes accounts too. The
 * edit makes catalog call billing's private helper, which is both a new
 * writer of invoices and a call that enters billing off its exports.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CheckIntentResult } from "@suss/checker-intent";
import type { ModuleChanges } from "./diffModules.js";

const fixtures = path.resolve(__dirname, "../../../fixtures");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "suss-modules-"));

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
  /** The `extract` arguments before `-o`, given the copy's root. */
  readonly extract: (root: string) => string[];
  /** The file the edit rewrites, and what it becomes. */
  readonly edit: { file: string; content: string };
  readonly exports: Record<string, string>;
  readonly helper: string;
}

const LANGUAGES: Record<string, Language> = {
  TypeScript: {
    fixture: "modules-typescript",
    extract: (root) => ["-f", "pg", "--dir", path.join(root, "src")],
    edit: {
      file: "src/catalog/pricing.ts",
      content: `import { saveInvoice } from "../billing/invoiceStore.js";
import { pool } from "../db.js";

export async function priceFor(sku: string): Promise<number> {
  await pool.query("UPDATE accounts SET last_priced_at = now() WHERE sku = $1", [
    sku,
  ]);
  await saveInvoice(sku);
  return 10;
}
`,
    },
    exports: {
      "fn:billing::chargeInvoice": "src/billing/charge.ts",
      "fn:catalog::priceFor": "src/catalog/pricing.ts",
    },
    helper: "saveInvoice",
  },
  Python: {
    fixture: "modules-python",
    extract: (root) => [
      "-f",
      `sqlalchemy=${path.join(root, "suss.sqlalchemy.json")}`,
      "--dir",
      root,
    ],
    edit: {
      file: "app/catalog/pricing.py",
      content: `from sqlalchemy import text

from app.billing.invoice_store import save_invoice


def price_for(pool, sku):
    pool.execute(
        text("UPDATE accounts SET last_priced_at = now() WHERE sku = :sku"),
        {"sku": sku},
    )
    save_invoice(pool, sku)
    return 10
`,
    },
    exports: {
      "fn:billing::charge_invoice": "app/billing/charge.py",
      "fn:catalog::price_for": "app/catalog/pricing.py",
    },
    helper: "save_invoice",
  },
  Ruby: {
    fixture: "modules-ruby",
    extract: (root) => ["-f", "pg-ruby", "--dir", root],
    edit: {
      file: "lib/catalog.rb",
      content: `require "pg"

module Catalog
  def self.price_for(sku)
    conn = PG.connect(ENV["DATABASE_URL"])
    conn.exec_params(
      "UPDATE accounts SET last_priced_at = now() WHERE sku = $1",
      [sku]
    )
    Billing::InvoiceStore.save(sku)
    10
  end
end
`,
    },
    exports: {
      "fn:billing::Billing.charge_invoice": "lib/billing.rb",
      "fn:catalog::Catalog.price_for": "lib/catalog.rb",
    },
    helper: "save",
  },
};

interface Run {
  root: string;
  before: string;
  after: string;
  summaries: BehavioralSummary[];
}

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
  return JSON.parse(fs.readFileSync(out, "utf8")) as BehavioralSummary[];
}

async function runOf(name: string, language: Language): Promise<Run> {
  const root = path.join(scratch, name);
  fs.cpSync(path.join(fixtures, language.fixture), root, { recursive: true });
  const before = path.join(scratch, `${name}-before`, "code.json");
  const after = path.join(scratch, `${name}-after`, "code.json");
  const summaries = await extractTo(language, root, before);
  fs.writeFileSync(path.join(root, language.edit.file), language.edit.content);
  await extractTo(language, root, after);
  return { root, before, after, summaries };
}

function keyOf(summary: BehavioralSummary): string | null {
  const semantics = summary.identity.boundaryBinding?.semantics;
  return semantics?.name === "function-call" &&
    semantics.module !== undefined &&
    semantics.exportName !== undefined
    ? `fn:${semantics.module}::${semantics.exportName}`
    : null;
}

for (const [name, language] of Object.entries(LANGUAGES)) {
  describe(`two modules in ${name}`, () => {
    let run: Run;

    beforeAll(async () => {
      run = await runOf(name, language);
    }, 120_000);

    it("keys each public export by its module and leaves the private helper unkeyed", () => {
      const keyed = Object.fromEntries(
        run.summaries.flatMap((summary) => {
          const key = keyOf(summary);
          return key === null ? [] : [[key, summary.location.file]];
        }),
      );
      expect(keyed).toEqual(language.exports);
      const helper = run.summaries.find(
        (summary) => summary.identity.name === language.helper,
      );
      expect(helper?.location.module).toBe("billing");
      expect(keyOf(helper as BehavioralSummary)).toBeNull();
    });

    it("writes each unit's module on its location", () => {
      expect(
        [...new Set(run.summaries.map((s) => s.location.module))].sort(),
      ).toEqual(["billing", "catalog"]);
    });

    it("reports the new writer and the call off billing's exports in the diff", async () => {
      const { out } = await suss([
        "inspect",
        "--diff",
        run.before,
        run.after,
        "--json",
      ]);
      const modules = (JSON.parse(out) as { modules: ModuleChanges }).modules;
      expect(modules.writers).toEqual([
        {
          store: "postgresql:invoices",
          before: ["billing"],
          after: ["billing", "catalog"],
        },
      ]);
      expect(modules.crossings.gained).toEqual([
        expect.objectContaining({
          from: "catalog",
          to: "billing",
          target: language.helper,
        }),
      ]);
      expect(modules.crossings.lost).toEqual([]);

      const printed = await suss(["inspect", "--diff", run.before, run.after]);
      expect(printed.out).toContain(
        "catalog now writes postgresql:invoices. Before this change only billing did.",
      );
      expect(printed.out).toContain("and billing does not export it.");
    });

    it("says the same lines the other way round when the edit is undone", async () => {
      const { out } = await suss(["inspect", "--diff", run.after, run.before]);
      expect(out).toContain(
        "catalog no longer writes postgresql:invoices. billing still does.",
      );
      expect(out).toContain("catalog no longer calls billing's");
    });

    it("answers what a module reaches, and groups a store's writers by module", async () => {
      const dir = path.dirname(run.after);
      const reach = await suss([
        "ask",
        "what does catalog reach",
        "--dir",
        dir,
        "--json",
      ]);
      const reached = JSON.parse(reach.out) as {
        items: Array<{ boundary: string; relations: string[] }>;
      };
      expect(reached.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            boundary: "postgresql:invoices",
            relations: ["writes"],
          }),
          expect.objectContaining({ boundary: "postgresql:accounts" }),
        ]),
      );

      const writes = await suss([
        "ask",
        "what writes postgresql:accounts",
        "--dir",
        dir,
        "--json",
      ]);
      const answer = JSON.parse(writes.out) as {
        headline: string;
        items: Array<{ module?: string }>;
        modules: Array<{ module: string; units: string[] }>;
      };
      expect(answer.headline).toContain("from billing and catalog");
      expect(answer.items.map((item) => item.module)).toEqual([
        "billing",
        "catalog",
      ]);
      expect(answer.modules.map((one) => one.module)).toEqual([
        "billing",
        "catalog",
      ]);
    });
  });
}

describe("a PRD scenario that links to a module export's outcome", () => {
  let intent: CheckIntentResult;

  beforeAll(async () => {
    const root = path.join(fixtures, "modules-typescript");
    const out = path.join(scratch, "prd", "code.json");
    await extractTo(LANGUAGES.TypeScript, root, out);
    const report = path.join(scratch, "prd-check.json");
    await suss([
      "check",
      "--dir",
      path.dirname(out),
      "--intent",
      path.join(root, "intent"),
      "--json",
      "--allow-empty",
      "-o",
      report,
    ]);
    intent = (
      JSON.parse(fs.readFileSync(report, "utf8")) as {
        intent: CheckIntentResult;
      }
    ).intent;
  }, 120_000);

  it("pairs the boundary intent with the export and resolves both scenario links", () => {
    expect(intent.findings).toEqual([]);
    expect(intent.unchecked).toEqual([]);
    expect(intent.checked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "boundary",
          intent: "billing-charge",
          boundary: "fn:billing::chargeInvoice",
          implementations: ["src/billing/charge.ts::chargeInvoice"],
        }),
        expect.objectContaining({ kind: "prd", scenarios: 2, resolved: 2 }),
      ]),
    );
  });
});
