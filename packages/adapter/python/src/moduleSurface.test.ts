import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { boundaryKey } from "@suss/behavioral-ir";

import { extractPythonProject } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const FILES: Record<string, string> = {
  "app/__init__.py": "",
  "app/billing/__init__.py": [
    "import os",
    "from .charge import charge_invoice",
    "from .service import InvoiceService",
    "from .ledger import _record",
    "",
    "VERSION = os.environ.get('BILLING_VERSION')",
    "",
    "def refund(invoice_id):",
    "    return invoice_id",
    "",
  ].join("\n"),
  "app/billing/charge.py": [
    "from .ledger import _record",
    "",
    "def charge_invoice(invoice_id):",
    "    _record(invoice_id)",
    "    return invoice_id",
    "",
  ].join("\n"),
  "app/billing/service.py": [
    "class InvoiceService:",
    "    rate = 2",
    "",
    "    def charge(self, invoice_id):",
    "        return invoice_id",
    "",
    "    def _audit(self):",
    "        return None",
    "",
  ].join("\n"),
  "app/billing/ledger.py": [
    "def _record(invoice_id):",
    "    return invoice_id",
    "",
  ].join("\n"),
  "app/ledger/entries.py": ["def post(entry):", "    return entry", ""].join(
    "\n",
  ),
  "app/reports.py": [
    "from app.billing import charge_invoice",
    "",
    "LATEST = charge_invoice('x')",
    "",
  ].join("\n"),
};

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-py-module-surface-")),
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
  const { summaries } = await extractPythonProject({
    files: Object.keys(FILES).map((file) => path.join(root, file)),
    roots: [root],
    packs: [],
    workspaceRoot: root,
    cacheDir: null,
    ...(withModules
      ? {
          modules: [
            { name: "billing", root: path.join(root, "app/billing") },
            // Its public file is not among the files read, so it exports nothing.
            {
              name: "ledger",
              root: path.join(root, "app/ledger"),
              public: [path.join(root, "app/ledger/__init__.py")],
            },
          ],
        }
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

describe("a Python module's public exports", () => {
  it("keys what __init__.py defines or imports, with a class's public methods, and leaves private names out", async () => {
    const summaries = await extract(true);
    expect(keys(summaries)).toEqual([
      "fn:billing::InvoiceService.charge",
      "fn:billing::charge_invoice",
      "fn:billing::refund",
    ]);
    const charge = summaries.find(
      (s) => keys([s])[0] === "fn:billing::charge_invoice",
    );
    expect(charge?.location.file).toBe("app/billing/charge.py");
  });

  it("stamps the module on the units under its root and on nothing else", async () => {
    const summaries = await extract(true);
    const record = summaries.find((s) => s.identity.name === "_record");
    expect(record?.location.module).toBe("billing");
    const monthly = summaries.filter(
      (s) => s.location.file === "app/reports.py",
    );
    expect(monthly.length).toBeGreaterThan(0);
    expect(monthly.every((s) => s.location.module === undefined)).toBe(true);
  });

  it("keys nothing and stamps nothing without a module list", async () => {
    const summaries = await extract(false);
    expect(keys(summaries)).toEqual([]);
    expect(summaries.every((s) => s.location.module === undefined)).toBe(true);
  });
});
