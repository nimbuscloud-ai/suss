import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installedLibraryInputs } from "./installedLibraries.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function project(installed: string[]): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-installed-")),
  );
  roots.push(root);
  for (const name of installed) {
    const dir = path.join(root, "node_modules", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
  }
  fs.mkdirSync(path.join(root, "apps", "api"), { recursive: true });
  return root;
}

const pack = (requiresImport: string[], discovery: string[] = []) => ({
  requiresImport,
  discovery: [{ requiresImport: discovery }] as never,
});

describe("the installed libraries a run's packs read", () => {
  it("are the manifests in the nearest node_modules up from the project", () => {
    const root = project(["pg", "express"]);

    const inputs = installedLibraryInputs(
      [pack(["pg"], ["express"])],
      path.join(root, "apps", "api"),
    ).discoveryInputs();

    expect(inputs).toEqual([
      path.join(root, "node_modules", "express", "package.json"),
      path.join(root, "node_modules", "pg", "package.json"),
    ]);
  });

  it("are every package under a scope a pack gives on its own", () => {
    const root = project(["@ts-rest/core", "@ts-rest/express"]);

    const inputs = installedLibraryInputs(
      [pack(["@ts-rest"])],
      root,
    ).discoveryInputs();

    expect(inputs).toEqual([
      path.join(root, "node_modules", "@ts-rest", "core", "package.json"),
      path.join(root, "node_modules", "@ts-rest", "express", "package.json"),
    ]);
  });

  it("leave out a library that is not installed", () => {
    const root = project([]);

    expect(
      installedLibraryInputs([pack(["mongoose"])], root).discoveryInputs(),
    ).toEqual([]);
  });

  it("are none when the run has no folder to look from", () => {
    expect(
      installedLibraryInputs([pack(["pg"])], undefined).discoveryInputs(),
    ).toEqual([]);
  });
});
