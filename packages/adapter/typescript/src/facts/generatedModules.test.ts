import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GeneratedModules, generatedModulesOf } from "./generatedModules.js";

let root: string;
let consumer: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-generated-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "generated/client"), { recursive: true });
  fs.writeFileSync(path.join(root, "generated/client/schema.prisma"), "");
  fs.writeFileSync(path.join(root, "generated/client/index.d.ts"), "");
  fs.mkdirSync(path.join(root, "src/handwritten"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/handwritten/index.ts"), "");
  consumer = path.join(root, "src/db.ts");
});

describe("GeneratedModules", () => {
  it("finds the marker when the specifier names a file in the directory", () => {
    const generated = new GeneratedModules(["schema.prisma"]);
    expect(
      generated.reachedFrom(consumer, ["../generated/client/index.js"]),
    ).toBe(true);
  });

  it("finds the marker when the specifier names the directory itself", () => {
    const generated = new GeneratedModules(["schema.prisma"]);
    expect(generated.reachedFrom(consumer, ["../generated/client"])).toBe(true);
  });

  it("leaves a relative import of ordinary project code alone", () => {
    const generated = new GeneratedModules(["schema.prisma"]);
    expect(generated.reachedFrom(consumer, ["./handwritten/index.js"])).toBe(
      false,
    );
  });

  it("ignores a package specifier, which the import gate already covers", () => {
    const generated = new GeneratedModules(["schema.prisma"]);
    expect(generated.reachedFrom(consumer, ["@prisma/client"])).toBe(false);
  });

  it("answers no for a pack that declares no marker", () => {
    const generated = new GeneratedModules([]);
    expect(generated.declared).toBe(false);
    expect(
      generated.reachedFrom(consumer, ["../generated/client/index.js"]),
    ).toBe(false);
  });
});

describe("generatedModulesOf", () => {
  it("deduplicates the markers two packs ask for", () => {
    const generated = generatedModulesOf([
      { name: "a", generatedModuleMarkers: ["schema.prisma"] },
      { name: "b", generatedModuleMarkers: ["schema.prisma", "codegen.yml"] },
      { name: "c" },
    ]);
    expect(generated.key).toBe("codegen.yml,schema.prisma");
  });

  it("counts an import into a directory the project's configuration names, before anything is written there", () => {
    const asked: string[] = [];
    const generated = generatedModulesOf([
      {
        name: "orm",
        generatedModuleDirs: (fromDir) => {
          asked.push(fromDir);
          return [path.join(root, "src/generated/orm")];
        },
      },
    ]);
    expect(generated.declared).toBe(true);
    expect(generated.key).toBe("|orm");
    expect(generated.reachedFrom(consumer, ["./generated/orm/client"])).toBe(
      true,
    );
    expect(generated.reachedFrom(consumer, ["./generated/orm"])).toBe(true);
    expect(generated.reachedFrom(consumer, ["./generated/ormish"])).toBe(false);
    expect(asked).toEqual([path.join(root, "src")]);
  });
});
