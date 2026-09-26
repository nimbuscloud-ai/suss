import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atLeast, findSuss } from "../scripts/suss.mjs";

let work: string;
let project: string;
let plugin: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "suss-find-"));
  project = path.join(work, "project");
  plugin = path.join(work, "plugin");
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "suss", version: "0.40.0" }),
  );
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function install(dir: string, version: string, built = true): string {
  const pkg = path.join(dir, "node_modules", "@suss", "cli");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "@suss/cli",
      version,
      bin: { suss: "./dist/bin.js" },
    }),
  );
  if (built) {
    fs.writeFileSync(path.join(pkg, "dist", "bin.js"), "");
  }
  return path.join(pkg, "dist", "bin.js");
}

describe("which suss the hooks run", () => {
  it("runs the project's own suss when it is the pinned release or newer", () => {
    const bin = install(project, "0.41.2");
    install(plugin, "0.40.0");

    const suss = findSuss(project, plugin);

    expect(suss.from).toBe("project");
    expect(suss.prefix).toEqual([bin]);
    expect(suss.command).toBe(process.execPath);
  });

  it("finds a suss installed in a directory above the project", () => {
    const bin = install(work, "0.40.0");

    expect(findSuss(project, plugin).prefix).toEqual([bin]);
  });

  it("passes over a project suss older than the pin for the plugin's own", () => {
    install(project, "0.33.1");
    const own = install(plugin, "0.40.0");

    const suss = findSuss(project, plugin);

    expect(suss.from).toBe("plugin");
    expect(suss.prefix).toEqual([own]);
  });

  it("passes over a checkout that was never built", () => {
    install(project, "0.40.0", false);
    const own = install(plugin, "0.40.0");

    expect(findSuss(project, plugin).prefix).toEqual([own]);
  });

  it("fetches the pinned release through npx when nothing is installed", () => {
    const suss = findSuss(project, plugin);

    expect(suss.from).toBe("npx");
    expect(suss.prefix).toEqual([
      "--yes",
      "--package=@suss/cli@0.40.0",
      "suss",
    ]);
  });
});

describe("atLeast", () => {
  it("compares the three numbers in order", () => {
    expect(atLeast("0.40.0", "0.40.0")).toBe(true);
    expect(atLeast("0.40.1", "0.40.0")).toBe(true);
    expect(atLeast("1.0.0", "0.40.0")).toBe(true);
    expect(atLeast("0.39.9", "0.40.0")).toBe(false);
    expect(atLeast("0.4.10", "0.40.0")).toBe(false);
  });

  it("takes any version when nothing is pinned, and no unreadable one otherwise", () => {
    expect(atLeast(null, null)).toBe(true);
    expect(atLeast("next", "0.40.0")).toBe(false);
  });
});
