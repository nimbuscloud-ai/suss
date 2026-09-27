import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectModules } from "./projectModules.js";
import { UsageError } from "./usageError.js";

let root: string;

function write(relPath: string, content: unknown): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

function withModules(modules: unknown): void {
  write("suss.json", { version: 1, read: [], modules });
}

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-project-modules-")),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("projectModules", () => {
  it("reads the nearest suss.json above the project and makes each path absolute", () => {
    withModules([
      { name: "billing", root: "src/billing" },
      { name: "catalog", root: "src/catalog", public: "src/catalog/api.ts" },
    ]);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });

    expect(projectModules(path.join(root, "src"))).toEqual([
      { name: "billing", root: path.join(root, "src/billing") },
      {
        name: "catalog",
        root: path.join(root, "src/catalog"),
        public: [path.join(root, "src/catalog/api.ts")],
      },
    ]);
  });

  it("gives no modules for a project without a list, or without a suss.json it can parse", () => {
    write("suss.json", { version: 1, read: [] });
    expect(projectModules(root)).toEqual([]);
    write("suss.json", "{ not json");
    expect(projectModules(root)).toEqual([]);
  });

  it("refuses a module named like a package in the workspace", () => {
    write("package.json", { name: "shop", workspaces: ["packages/*"] });
    write("packages/billing/package.json", { name: "billing" });
    withModules([{ name: "billing", root: "src/billing" }]);

    expect(() => projectModules(root)).toThrow(UsageError);
    expect(() => projectModules(root)).toThrow(/fn:billing::<export>/);
  });

  it("refuses a module named like the project's own package", () => {
    write("package.json", { name: "shop" });
    withModules([{ name: "shop", root: "src/shop" }]);

    expect(() => projectModules(root)).toThrow(/same name as a package/);
  });

  it("refuses a name that could be read as a path, and a name used twice", () => {
    withModules([{ name: "src/billing", root: "src/billing" }]);
    expect(() => projectModules(root)).toThrow(/cannot look like a path/);

    withModules([
      { name: "billing", root: "a" },
      { name: "billing", root: "b" },
    ]);
    expect(() => projectModules(root)).toThrow(/two modules are called/);
  });

  it("refuses an entry that is not a name and a root", () => {
    withModules([{ name: "billing" }]);
    expect(() => projectModules(root)).toThrow(/"modules" has to be a list/);
  });
});
