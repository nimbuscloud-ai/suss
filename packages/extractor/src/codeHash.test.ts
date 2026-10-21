import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createCodeHasher } from "./codeHash.js";

/** Writes each file under a fresh directory, returned with symlinks resolved. */
function writeTree(files: Record<string, string>): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-code-hash-")),
  );
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return root;
}

function manifest(name: string, exports: unknown): string {
  return JSON.stringify({ name, type: "module", exports });
}

const DUAL_BUILD = {
  ".": { import: "./dist/index.js", require: "./dist/index.cjs" },
};

function relativeFiles(root: string, entry: string): string[] {
  return createCodeHasher()
    .codeFiles(path.join(root, entry))
    .map((file) => path.relative(root, file));
}

describe("createCodeHasher", () => {
  it("follows a chunk the bundler split out, so editing the chunk changes the hash", () => {
    const root = writeTree({
      "dist/index.js": 'import { a } from "./chunk-A1.js";\nexport { a };',
      "dist/chunk-A1.js": "export const a = 1;",
    });
    const entry = path.join(root, "dist/index.js");
    const before = createCodeHasher().codeHash(entry);

    fs.writeFileSync(
      path.join(root, "dist/chunk-A1.js"),
      "export const a = 2;",
    );

    expect(createCodeHasher().codeHash(entry)).not.toBe(before);
  });

  it("follows an import into a suss package and hashes the build an import loads", () => {
    const root = writeTree({
      "node_modules/@suss/adapter/dist/index.js":
        'import { read } from "@suss/values";',
      "node_modules/@suss/values/package.json": manifest(
        "@suss/values",
        DUAL_BUILD,
      ),
      "node_modules/@suss/values/dist/index.js": "export const read = 1;",
      "node_modules/@suss/values/dist/index.cjs": "exports.read = 1;",
    });

    expect(
      relativeFiles(root, "node_modules/@suss/adapter/dist/index.js"),
    ).toEqual([
      "node_modules/@suss/adapter/dist/index.js",
      "node_modules/@suss/values/dist/index.js",
    ]);
  });

  it("hashes the CommonJS build for a require call", () => {
    const root = writeTree({
      "node_modules/@suss/adapter/dist/index.cjs":
        'var import_values = require("@suss/values");',
      "node_modules/@suss/values/package.json": manifest(
        "@suss/values",
        DUAL_BUILD,
      ),
      "node_modules/@suss/values/dist/index.js": "export const read = 1;",
      "node_modules/@suss/values/dist/index.cjs": "exports.read = 1;",
    });

    expect(
      relativeFiles(root, "node_modules/@suss/adapter/dist/index.cjs"),
    ).toContain("node_modules/@suss/values/dist/index.cjs");
  });

  it("follows a subpath entry, a dynamic import and a re-export", () => {
    const root = writeTree({
      "dist/index.js": [
        'import { files } from "@suss/ir/files";',
        'export * from "@suss/ir/schemas";',
        'const late = () => import("@suss/ir");',
      ].join("\n"),
      "node_modules/@suss/ir/package.json": manifest("@suss/ir", {
        ".": { import: "./dist/index.js" },
        "./files": { import: "./dist/files.js" },
        "./schemas": { import: "./dist/schemas.js" },
      }),
      "node_modules/@suss/ir/dist/index.js": "export const ir = 1;",
      "node_modules/@suss/ir/dist/files.js": "export const files = 1;",
      "node_modules/@suss/ir/dist/schemas.js": "export const schemas = 1;",
    });

    expect(relativeFiles(root, "dist/index.js")).toEqual([
      "dist/index.js",
      "node_modules/@suss/ir/dist/files.js",
      "node_modules/@suss/ir/dist/schemas.js",
      "node_modules/@suss/ir/dist/index.js",
    ]);
  });

  it("follows a package into the packages it imports in turn", () => {
    const root = writeTree({
      "dist/express.js": 'import { pack } from "@suss/recognize";',
      "node_modules/@suss/recognize/package.json": manifest(
        "@suss/recognize",
        DUAL_BUILD,
      ),
      "node_modules/@suss/recognize/dist/index.js":
        'import { parse } from "@suss/sql";',
      "node_modules/@suss/sql/package.json": manifest("@suss/sql", DUAL_BUILD),
      "node_modules/@suss/sql/dist/index.js": "export const parse = 1;",
    });

    expect(relativeFiles(root, "dist/express.js")).toContain(
      "node_modules/@suss/sql/dist/index.js",
    );
  });

  it("resolves a package from the file that imports it, so a nested copy wins", () => {
    const nested = "node_modules/@suss/adapter/node_modules/@suss/values";
    const root = writeTree({
      "node_modules/@suss/adapter/dist/index.js":
        'import { read } from "@suss/values";',
      [`${nested}/package.json`]: manifest("@suss/values", DUAL_BUILD),
      [`${nested}/dist/index.js`]: "export const read = 2;",
      "node_modules/@suss/values/package.json": manifest(
        "@suss/values",
        DUAL_BUILD,
      ),
      "node_modules/@suss/values/dist/index.js": "export const read = 1;",
    });

    expect(
      relativeFiles(root, "node_modules/@suss/adapter/dist/index.js"),
    ).toContain(`${nested}/dist/index.js`);
  });

  it("leaves out other libraries and imports that name no file", () => {
    const root = writeTree({
      "dist/index.js": [
        'import { z } from "zod";',
        'import "./missing.js";',
        'const message = "copy it from \\"@suss/nowhere\\"";',
      ].join("\n"),
      "node_modules/zod/package.json": manifest("zod", "./index.js"),
      "node_modules/zod/index.js": "export const z = 1;",
    });

    expect(relativeFiles(root, "dist/index.js")).toEqual(["dist/index.js"]);
  });

  it("answers empty when the entry cannot be read", () => {
    const hasher = createCodeHasher();
    const absent = path.join(os.tmpdir(), "suss-absent-entry.js");

    expect(hasher.codeHash(absent)).toBe("");
    expect(hasher.codeFiles(absent)).toEqual([]);
  });

  it("keeps the first answer, since a process loads a module only once", () => {
    const root = writeTree({ "dist/index.js": "one" });
    const entry = path.join(root, "dist/index.js");
    const hasher = createCodeHasher();
    const first = hasher.codeHash(entry);

    fs.writeFileSync(entry, "two");

    expect(hasher.codeHash(entry)).toBe(first);
    expect(createCodeHasher().codeHash(entry)).not.toBe(first);
  });
});
