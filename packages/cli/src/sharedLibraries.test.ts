import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatInitReport, inspectProject } from "./init.js";
import { findInitTargets } from "./initTargets.js";
import { setupReads } from "./projectSetup.js";
import { localPackageDir } from "./workspaces.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRepo(files: Record<string, unknown>): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-shared-")),
  );
  roots.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }
  return root;
}

/** Links a workspace package into the root's node_modules, as npm and yarn do. */
function linkAtRoot(root: string, name: string, directory: string): void {
  const link = path.join(root, "node_modules", name);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(root, directory), link);
}

/** A workspace with a service, the database helpers it imports, and helpers nothing imports. */
function shop(): string {
  return makeRepo({
    "package.json": { name: "shop", workspaces: ["apps/*", "packages/*"] },
    "apps/api/package.json": {
      name: "@shop/api",
      dependencies: { express: "*", "@shop/db": "*" },
    },
    "apps/api/tsconfig.json": { include: ["src"] },
    "apps/api/src/server.ts":
      'import express from "express";\nexport const app = express();\n',
    "packages/db/package.json": {
      name: "@shop/db",
      dependencies: { pg: "*" },
      devDependencies: { vitest: "*" },
    },
    "packages/db/tsconfig.json": { include: ["src"] },
    "packages/db/src/orders.ts":
      'import { Pool } from "pg";\nexport const orders = (pool: Pool) => pool.query("select * from orders");\n',
    "packages/cache/package.json": {
      name: "@shop/cache",
      dependencies: { ioredis: "*" },
    },
    "packages/cache/tsconfig.json": { include: ["src"] },
    "packages/cache/src/cache.ts":
      'import Redis from "ioredis";\nexport const cache = new Redis();\n',
  });
}

function namesOf(suggestions: ReadonlyArray<{ name: string }>): string[] {
  return suggestions.map((suggestion) => suggestion.name);
}

describe("where a sibling package lives", () => {
  it("follows the link npm and yarn write at the root", () => {
    const root = shop();
    linkAtRoot(root, "@shop/db", "packages/db");

    expect(localPackageDir(path.join(root, "apps/api"), "@shop/db")).toBe(
      path.join(root, "packages/db"),
    );
  });

  it("follows the link pnpm writes beside the importer", () => {
    const root = shop();
    const link = path.join(root, "apps/api/node_modules/@shop/db");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(root, "packages/db"), link);

    expect(localPackageDir(path.join(root, "apps/api"), "@shop/db")).toBe(
      path.join(root, "packages/db"),
    );
  });

  it("finds it from the workspace declaration before an install", () => {
    const root = shop();

    expect(localPackageDir(path.join(root, "apps/api"), "@shop/db")).toBe(
      path.join(root, "packages/db"),
    );
  });

  it("leaves out a package installed from a registry", () => {
    const root = shop();
    fs.mkdirSync(path.join(root, "node_modules/express"), { recursive: true });

    expect(localPackageDir(path.join(root, "apps/api"), "express")).toBeNull();
  });

  it("leaves out a link to a folder outside the repository", () => {
    const root = shop();
    const elsewhere = makeRepo({ "package.json": { name: "@shop/db" } });
    fs.mkdirSync(path.join(root, "node_modules/@shop"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(root, "node_modules/@shop/db"));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "shop" }),
    );

    expect(localPackageDir(path.join(root, "apps/api"), "@shop/db")).toBeNull();
  });
});

describe("a service that imports a sibling package", () => {
  it("gets the packs the sibling's dependencies match", async () => {
    const root = shop();
    linkAtRoot(root, "@shop/db", "packages/db");

    const report = await inspectProject(path.join(root, "apps/api"));

    expect(report.suggestions).toContainEqual(
      expect.objectContaining({
        name: "pg",
        because: "pg in dependencies of @shop/db",
      }),
    );
  });

  it("does not get the packs of the sibling's dev dependencies", async () => {
    const root = shop();

    const report = await inspectProject(path.join(root, "apps/api"));

    expect(namesOf(report.suggestions)).not.toContain("vitest");
  });
});

describe("a workspace package with no entry point of its own", () => {
  it("gets no read, and says which package reads it", async () => {
    const root = shop();

    const targets = await findInitTargets(root);
    const db = targets.find((target) => target.directory === "packages/db");

    expect(db?.report.sharedLibrary).toEqual({
      packs: expect.arrayContaining(["pg"]),
      readBy: ["apps/api"],
    });
    expect(
      setupReads(targets).map((entry) =>
        entry.kind === "extract" ? entry.dir : entry.file,
      ),
    ).toEqual(["apps/api"]);
    expect(formatInitReport(db?.report ?? fail(), "packages/db")).toContain(
      "read through apps/api, which depend on it",
    );
  });

  it("says nothing reaches it when no package that is read depends on it", async () => {
    const root = shop();

    const targets = await findInitTargets(root);
    const cache = targets.find(
      (target) => target.directory === "packages/cache",
    );

    expect(cache?.report.sharedLibrary?.readBy).toEqual([]);
    expect(formatInitReport(cache?.report ?? fail(), "packages/cache")).toMatch(
      /is shared code with no entry point of its own[\s\S]*nothing reaches it/,
    );
  });

  it("keeps the read of a package with an entry point of its own", async () => {
    const root = shop();
    fs.writeFileSync(
      path.join(root, "packages/db/package.json"),
      JSON.stringify({
        name: "@shop/db",
        dependencies: { pg: "*", express: "*" },
      }),
    );

    const targets = await findInitTargets(root);

    expect(
      targets.find((target) => target.directory === "packages/db")?.report
        .sharedLibrary,
    ).toBeUndefined();
  });
});

function fail(): never {
  throw new Error("no such target");
}
