import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { extractionConfigStamp } from "./adapterStamp.js";
import {
  moduleOfFile,
  modulesStamp,
  settleModules,
  stampModules,
} from "./declaredModules.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { SettledModule } from "./declaredModules.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-declared-modules-"));
fs.mkdirSync(path.join(root, "billing"));
fs.writeFileSync(path.join(root, "billing", "index.ts"), "");

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const billing: SettledModule = {
  name: "billing",
  root: "/app/src/billing",
  public: ["/app/src/billing/index.ts"],
};
const invoices: SettledModule = {
  name: "invoices",
  root: "/app/src/billing/invoices",
  public: [],
};
const gem: SettledModule = {
  name: "catalog",
  root: "/app/lib/catalog",
  public: ["/app/lib/catalog.rb"],
};

function summaryIn(file: string): BehavioralSummary {
  return { location: { file } } as unknown as BehavioralSummary;
}

describe("settleModules", () => {
  it("keeps the public files suss.json gave, and otherwise the language's candidates on disk", () => {
    const settled = settleModules(
      [
        { name: "billing", root: path.join(root, "billing") },
        { name: "catalog", root: path.join(root, "catalog"), public: ["x.ts"] },
      ],
      ["index.ts", "index.tsx"],
    );
    expect(settled.map((module) => module.public)).toEqual([
      [path.join(root, "billing", "index.ts")],
      ["x.ts"],
    ]);
  });

  it("puts the module's name into a candidate, which may be outside the root", () => {
    fs.writeFileSync(path.join(root, "billing.rb"), "");
    const [billing] = settleModules(
      [{ name: "billing", root: path.join(root, "billing") }],
      ["{name}.rb", "../{name}.rb"],
    );
    expect(billing?.public).toEqual([path.join(root, "billing.rb")]);
  });

  it("settles to nothing when there is no list", () => {
    expect(settleModules(undefined, [])).toEqual([]);
  });
});

describe("moduleOfFile", () => {
  const modules = [billing, invoices, gem];

  it("gives the deepest root that contains the file", () => {
    expect(moduleOfFile(modules, "/app/src/billing/charge.ts")?.name).toBe(
      "billing",
    );
    expect(
      moduleOfFile(modules, "/app/src/billing/invoices/store.ts")?.name,
    ).toBe("invoices");
  });

  it("gives a module its public file when the file is next to the root", () => {
    expect(moduleOfFile(modules, "/app/lib/catalog.rb")?.name).toBe("catalog");
  });

  it("gives nothing for a file under no root, or for the root itself", () => {
    expect(moduleOfFile(modules, "/app/src/db.ts")).toBeUndefined();
    expect(moduleOfFile(modules, "/app/src/billing")).toBeUndefined();
    expect(moduleOfFile(modules, "/app/src/billingx/a.ts")).toBeUndefined();
  });
});

describe("stampModules", () => {
  it("writes the module on each summary in one, and leaves the rest alone", () => {
    const inside = summaryIn("src/billing/charge.ts");
    const outside = summaryIn("src/db.ts");
    stampModules([inside, outside], [billing], "/app");
    expect(inside.location.module).toBe("billing");
    expect(outside.location).not.toHaveProperty("module");
  });
});

describe("the module list in the cache key", () => {
  it("leaves a key without a list as it was", () => {
    expect(modulesStamp([])).toBeUndefined();
    expect(extractionConfigStamp({ modules: [] })).toBe(
      extractionConfigStamp({}),
    );
  });

  it("changes the key when a module's public files change", () => {
    const moved = { ...billing, public: ["/app/src/billing/api.ts"] };
    expect(extractionConfigStamp({ modules: [billing] })).not.toBe(
      extractionConfigStamp({ modules: [moved] }),
    );
  });
});
