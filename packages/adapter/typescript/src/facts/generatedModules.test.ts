import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { createPackTallies } from "@suss/extractor";

import {
  declaredByPackage,
  generatedModulesOf,
  NO_GENERATOR,
} from "./generatedModules.js";

import type { GeneratedModuleSpec } from "@suss/extractor";

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

/** The generated modules of one pack, `orm`, that writes a copy of `orm-client`. */
function oneGenerator(spec: Omit<GeneratedModuleSpec, "of">) {
  return generatedModulesOf([
    { name: "orm", generatedModules: { of: "orm-client", ...spec } },
  ]);
}

const MARKED = { markers: ["schema.prisma"] };

describe("GeneratedModules", () => {
  it("finds the marker when the specifier points at a file in the directory", () => {
    expect(
      oneGenerator(MARKED).reachedFrom(
        consumer,
        ["../generated/client/index.js"],
        {},
      ),
    ).toBe(true);
  });

  it("finds the marker when the specifier points at the directory itself", () => {
    expect(
      oneGenerator(MARKED).reachedFrom(consumer, ["../generated/client"], {}),
    ).toBe(true);
  });

  it("leaves a relative import of ordinary project code alone", () => {
    expect(
      oneGenerator(MARKED).reachedFrom(
        consumer,
        ["./handwritten/index.js"],
        {},
      ),
    ).toBe(false);
  });

  it("ignores a package specifier, which the import gate already covers", () => {
    expect(
      oneGenerator(MARKED).reachedFrom(consumer, ["@prisma/client"], {}),
    ).toBe(false);
  });

  it("answers no for a pack that declares no marker and no directories", () => {
    const generated = oneGenerator({});
    expect(generated.declared).toBe(false);
    expect(
      generated.reachedFrom(consumer, ["../generated/client/index.js"], {}),
    ).toBe(false);
  });

  it("says which package an import into the generated directory is", () => {
    const generated = generatedModulesOf([
      { name: "orm", generatedModules: { of: "orm-client", ...MARKED } },
      {
        name: "rpc",
        generatedModules: {
          of: "rpc-stubs",
          dirs: () => [path.join(root, "src/stubs")],
        },
      },
    ]);
    expect(generated.packagesAt(consumer, "../generated/client", {})).toEqual([
      "orm-client",
    ]);
    expect(generated.packagesAt(consumer, "./stubs/user", {})).toEqual([
      "rpc-stubs",
    ]);
    expect(generated.packagesAt(consumer, "./handwritten", {})).toEqual([]);
  });

  it("says a file in the generated directory is declared by the package", () => {
    const generated = generatedModulesOf([
      { name: "orm", generatedModules: { of: "orm-client", ...MARKED } },
      {
        name: "rpc",
        generatedModules: {
          of: "rpc-stubs",
          dirs: () => [path.join(root, "src/stubs")],
        },
      },
    ]);
    const client = path.join(root, "generated/client/index.d.ts");
    const stub = path.join(root, "src/stubs/nested/user.d.ts");

    expect(declaredByPackage(client, "orm-client", generated)).toBe(true);
    expect(declaredByPackage(client, "rpc-stubs", generated)).toBe(false);
    expect(declaredByPackage(stub, "rpc-stubs", generated)).toBe(true);
    expect(declaredByPackage(consumer, "orm-client", generated)).toBe(false);
    expect(declaredByPackage(client, "orm-client")).toBe(false);
    expect(
      declaredByPackage(
        "/repo/node_modules/orm-client/index.d.ts",
        "orm-client",
        NO_GENERATOR,
      ),
    ).toBe(true);
  });
});

describe("generatedModulesOf", () => {
  it("keys the modules by the packs that generate them", () => {
    const generated = generatedModulesOf([
      { name: "b", generatedModules: { of: "b-client", ...MARKED } },
      { name: "a", generatedModules: { of: "a-client", markers: ["a.yml"] } },
      { name: "c" },
    ]);
    expect(generated.key).toBe("a,b");
  });

  it("counts an import into a directory the project's configuration names, before anything is written there", () => {
    const asked: string[] = [];
    const generated = oneGenerator({
      dirs: (fromDir) => {
        asked.push(fromDir);
        return [path.join(root, "src/generated/orm")];
      },
    });
    expect(generated.declared).toBe(true);
    expect(generated.key).toBe("orm");
    expect(
      generated.reachedFrom(consumer, ["./generated/orm/client"], {}),
    ).toBe(true);
    expect(generated.reachedFrom(consumer, ["./generated/orm"], {})).toBe(true);
    expect(generated.reachedFrom(consumer, ["./generated/ormish"], {})).toBe(
      false,
    );
    expect(asked).toEqual([path.join(root, "src")]);
  });

  it("counts an import through the project's baseUrl into a directory the configuration names", () => {
    const generated = oneGenerator({
      dirs: () => [path.join(root, "src/generated/orm")],
    });
    const options = {
      baseUrl: root,
      paths: { "@orm/*": ["src/generated/orm/*"] },
    };
    expect(
      generated.reachedFrom(consumer, ["src/generated/orm/client"], options),
    ).toBe(true);
    expect(generated.reachedFrom(consumer, ["@orm/client"], options)).toBe(
      true,
    );
    expect(generated.reachedFrom(consumer, ["src/handwritten"], options)).toBe(
      false,
    );
    expect(generated.packagesAt(consumer, "@orm/client", options)).toEqual([
      "orm-client",
    ]);
  });

  it("leaves a package alone that baseUrl maps into a folder containing the marker", () => {
    // The project's own schema folder contains the same marker a
    // generated directory does, and `prisma/config` maps into it.
    fs.mkdirSync(path.join(root, "prisma"), { recursive: true });
    fs.writeFileSync(path.join(root, "prisma/schema.prisma"), "");
    const generated = oneGenerator(MARKED);
    const options = { baseUrl: root };
    expect(generated.reachedFrom(consumer, ["prisma/config"], options)).toBe(
      false,
    );
    expect(generated.reachedFrom(consumer, ["prisma"], options)).toBe(false);
    expect(
      generated.reachedFrom(consumer, ["../generated/client"], options),
    ).toBe(true);
  });

  it("counts nothing as generated where the pack's hook throws, and puts the throw on its tally", () => {
    const tallies = createPackTallies([{ name: "orm" }]);
    const noise = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const generated = generatedModulesOf(
        [
          {
            name: "orm",
            generatedModules: {
              of: "orm-client",
              dirs: () => {
                throw new Error("no configuration");
              },
            },
          },
        ],
        tallies,
      );
      expect(generated.reachedFrom(consumer, ["./generated/orm"], {})).toBe(
        false,
      );
    } finally {
      noise.mockRestore();
    }
    expect(tallies.get("orm")?.failures).toEqual([
      {
        hook: "generatedModules.dirs",
        file: path.join(root, "src"),
        message: "no configuration",
      },
    ]);
  });
});
