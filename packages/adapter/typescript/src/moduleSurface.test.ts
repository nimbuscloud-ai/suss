import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { boundaryKey } from "@suss/behavioral-ir";

import { createTypeScriptAdapter } from "./adapter.js";
import { moduleSurfacePack, settleTypeScriptModules } from "./moduleSurface.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "shop" }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: { target: "es2022", module: "esnext", strict: true },
    include: ["src/**/*"],
  }),
  "src/billing/index.ts": `
    export { chargeInvoice } from "./charge";
    export { InvoiceService } from "./service";
  `,
  "src/billing/charge.ts": `
    import { recordCharge } from "./ledger";
    export function chargeInvoice(id: string) {
      recordCharge(id);
      return id;
    }
  `,
  "src/billing/service.ts": `
    export class InvoiceService {
      charge(id: string) {
        return id.length;
      }
    }
  `,
  "src/billing/ledger.ts": `
    export function recordCharge(id: string) {
      return id;
    }
  `,
  "src/catalog/api.ts": `
    export const priceFor = (sku: string) => sku.length;
  `,
};

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-module-surface-")),
  );
  for (const [file, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function extract(
  modules?: Parameters<typeof createTypeScriptAdapter>[0]["modules"],
): Promise<BehavioralSummary[]> {
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(root, "tsconfig.json"),
    frameworks: [],
    cacheDir: null,
    ...(modules === undefined ? {} : { modules }),
  });
  return adapter.extractAll();
}

describe("a module's public exports", () => {
  it("keys each export by the module, reads a barrel through, and surfaces class methods", async () => {
    const summaries = await extract([
      { name: "billing", root: path.join(root, "src/billing") },
      {
        name: "catalog",
        root: path.join(root, "src/catalog"),
        public: [path.join(root, "src/catalog/api.ts")],
      },
    ]);
    const keys = summaries
      .map((summary) =>
        summary.identity.boundaryBinding === null
          ? null
          : boundaryKey(summary.identity.boundaryBinding),
      )
      .filter((key) => key !== null)
      .sort();
    expect(keys).toEqual([
      "fn:billing::InvoiceService.charge",
      "fn:billing::chargeInvoice",
      "fn:catalog::priceFor",
    ]);

    const ledger = summaries.find((s) => s.identity.name === "recordCharge");
    expect(ledger?.location.module).toBe("billing");
    expect(ledger?.identity.boundaryBinding?.recognition).toBe("reachable");
  });

  it("adds no pack and stamps no module without a list", async () => {
    expect(moduleSurfacePack(settleTypeScriptModules(undefined))).toBeNull();
    const summaries = await extract();
    expect(summaries.every((s) => s.location.module === undefined)).toBe(true);
  });

  it("adds no pack for a module with no public file", () => {
    const settled = settleTypeScriptModules([
      { name: "catalog", root: path.join(root, "src/catalog") },
    ]);
    expect(settled[0]?.public).toEqual([]);
    expect(moduleSurfacePack(settled)).toBeNull();
  });
});
