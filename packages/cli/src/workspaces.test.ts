import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readWorkspace } from "./workspaces.js";

describe("readWorkspace", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-workspace-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(relative: string, contents: string): void {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }

  function pkg(relative: string, name: string): void {
    write(`${relative}/package.json`, JSON.stringify({ name }));
  }

  function directories(): string[] {
    return readWorkspace(dir).packages.map((p) => p.directory);
  }

  it("treats a project with no workspace declaration as one project", () => {
    write("package.json", JSON.stringify({ name: "solo" }));

    const layout = readWorkspace(dir);
    expect(layout.declaredBy).toBeNull();
    expect(layout.packages).toEqual([]);
  });

  it("reads the npm workspaces array", () => {
    write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
    pkg("packages/api", "@acme/api");
    pkg("packages/web", "@acme/web");

    const layout = readWorkspace(dir);
    expect(layout.declaredBy).toBe("package.json");
    expect(layout.packages).toEqual([
      { directory: "packages/api", name: "@acme/api" },
      { directory: "packages/web", name: "@acme/web" },
    ]);
  });

  it("reads the yarn-berry object shape", () => {
    write(
      "package.json",
      JSON.stringify({ workspaces: { packages: ["apps/*"] } }),
    );
    pkg("apps/site", "@acme/site");

    expect(directories()).toEqual(["apps/site"]);
  });

  it("reads pnpm-workspace.yaml without a YAML parser", () => {
    write("package.json", JSON.stringify({ name: "root" }));
    write(
      "pnpm-workspace.yaml",
      [
        "packages:",
        "  - 'packages/*'",
        '  - "apps/*"',
        "",
        "shamefully-hoist: true",
        "",
      ].join("\n"),
    );
    pkg("packages/core", "@acme/core");
    pkg("apps/admin", "@acme/admin");

    const layout = readWorkspace(dir);
    expect(layout.declaredBy).toBe("pnpm-workspace.yaml");
    expect(layout.packages.map((p) => p.directory)).toEqual([
      "apps/admin",
      "packages/core",
    ]);
  });

  it("reads lerna.json", () => {
    write("package.json", JSON.stringify({ name: "root" }));
    write("lerna.json", JSON.stringify({ packages: ["modules/*"] }));
    pkg("modules/one", "one");

    expect(readWorkspace(dir).declaredBy).toBe("lerna.json");
    expect(directories()).toEqual(["modules/one"]);
  });

  it("falls back to the conventional directories when only turbo.json says so", () => {
    // turbo defers the package list to whatever package manager is in use,
    // so its presence establishes a workspace but declares nothing.
    write("package.json", JSON.stringify({ name: "root" }));
    write("turbo.json", JSON.stringify({ tasks: {} }));
    pkg("packages/core", "@acme/core");
    pkg("apps/web", "@acme/web");

    expect(readWorkspace(dir).declaredBy).toBe("turbo.json");
    expect(directories()).toEqual(["apps/web", "packages/core"]);
  });

  it("takes one star to mean exactly one level", () => {
    write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
    pkg("packages/core", "@acme/core");
    pkg("packages/framework/hono", "@acme/hono");

    expect(directories()).toEqual(["packages/core"]);
  });

  it("reaches a nested package when the pattern says two levels", () => {
    write("package.json", JSON.stringify({ workspaces: ["packages/*/*"] }));
    pkg("packages/framework/hono", "@acme/hono");
    pkg("packages/core", "@acme/core");

    expect(directories()).toEqual(["packages/framework/hono"]);
  });

  it("takes ** to mean any depth", () => {
    write("package.json", JSON.stringify({ workspaces: ["packages/**"] }));
    pkg("packages/core", "@acme/core");
    pkg("packages/framework/hono", "@acme/hono");

    expect(directories()).toEqual(["packages/core", "packages/framework/hono"]);
  });

  it("accepts a literal path alongside a glob", () => {
    write(
      "package.json",
      JSON.stringify({ workspaces: ["packages/*", "tools/cli"] }),
    );
    pkg("packages/core", "@acme/core");
    pkg("tools/cli", "@acme/cli");

    expect(directories()).toEqual(["packages/core", "tools/cli"]);
  });

  it("lists a directory once when two patterns both reach it", () => {
    write(
      "package.json",
      JSON.stringify({ workspaces: ["packages/*", "packages/core"] }),
    );
    pkg("packages/core", "@acme/core");

    expect(directories()).toEqual(["packages/core"]);
  });

  it("leaves out directories holding no package.json", () => {
    write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
    pkg("packages/core", "@acme/core");
    fs.mkdirSync(path.join(dir, "packages", "scratch"), { recursive: true });

    expect(directories()).toEqual(["packages/core"]);
  });

  it("skips node_modules and dot directories", () => {
    write("package.json", JSON.stringify({ workspaces: ["packages/**"] }));
    pkg("packages/core", "@acme/core");
    pkg("packages/node_modules/dep", "dep");
    pkg("packages/.cache/thing", "thing");

    expect(directories()).toEqual(["packages/core"]);
  });

  it("carries a null name for a package.json without one", () => {
    write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
    write(
      "packages/unnamed/package.json",
      JSON.stringify({ version: "1.0.0" }),
    );

    expect(readWorkspace(dir).packages).toEqual([
      { directory: "packages/unnamed", name: null },
    ]);
  });

  it("treats unreadable JSON as no declaration rather than throwing", () => {
    write("package.json", "{ this is not json");

    expect(readWorkspace(dir).packages).toEqual([]);
  });

  it("prefers the package.json declaration over the others", () => {
    write("package.json", JSON.stringify({ workspaces: ["npm-side/*"] }));
    write("pnpm-workspace.yaml", "packages:\n  - 'pnpm-side/*'\n");
    pkg("npm-side/a", "a");
    pkg("pnpm-side/b", "b");

    expect(readWorkspace(dir).declaredBy).toBe("package.json");
    expect(directories()).toEqual(["npm-side/a"]);
  });

  it("skips a declaration listing nothing and reads the next", () => {
    write("package.json", JSON.stringify({ workspaces: [] }));
    write("lerna.json", JSON.stringify({ packages: ["modules/*"] }));
    pkg("modules/one", "one");

    expect(readWorkspace(dir).declaredBy).toBe("lerna.json");
  });

  it("resolves the root it was given to an absolute path", () => {
    write("package.json", JSON.stringify({ name: "solo" }));
    expect(path.isAbsolute(readWorkspace(dir).root)).toBe(true);
  });
});
