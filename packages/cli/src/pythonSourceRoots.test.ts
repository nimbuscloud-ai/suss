import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extract } from "./extract.js";
import {
  formatUnreadSourceRoots,
  pythonSourceRoots,
} from "./pythonSourceRoots.js";

const FIXTURES = path.resolve(
  __dirname,
  "../../../fixtures/python-source-roots",
);
const BIN = path.resolve(__dirname, "../dist/bin.js");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-source-roots-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(relative: string, contents = ""): void {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function rootsUnder(project: string): string[] {
  return pythonSourceRoots(project).roots.map((root) =>
    path.relative(project, root),
  );
}

describe("pythonSourceRoots", () => {
  it.each([
    ["setuptools-package-dir", "lib"],
    ["setuptools-find", "lib"],
    ["hatch", "lib"],
    ["poetry", "lib"],
    ["plain-src", "src"],
    ["unreadable-toml", "src"],
  ])("finds the source directory of %s", (name, expected) => {
    expect(rootsUnder(path.join(FIXTURES, name))).toEqual([expected]);
  });

  it("names the pyproject it could not read, and still falls back to src", () => {
    const found = pythonSourceRoots(path.join(FIXTURES, "unreadable-toml"));
    expect(found.unread).toHaveLength(1);
    expect(found.unread[0]?.where).toBe("pyproject.toml");
    expect(found.unread[0]?.reason).toContain("not valid TOML");
  });

  it("adds nothing for a project with its package at the root", () => {
    write("orders/__init__.py");
    write("pyproject.toml", '[project]\nname = "orders"\n');
    expect(pythonSourceRoots(dir)).toEqual({ roots: [], unread: [] });
  });

  it("leaves src alone when it is a package itself", () => {
    write("src/__init__.py");
    write("src/orders/__init__.py");
    expect(rootsUnder(dir)).toEqual([]);
  });

  it("leaves src alone when nothing under it is a package", () => {
    write("src/app.py");
    expect(rootsUnder(dir)).toEqual([]);
  });

  it("prefers a declared directory over src", () => {
    write("src/tools/__init__.py");
    write("lib/orders/__init__.py");
    write(
      "pyproject.toml",
      '[tool.poetry]\npackages = [{ include = "orders", from = "lib" }]\n',
    );
    expect(rootsUnder(dir)).toEqual(["lib"]);
  });

  it("reads a package mapped to a directory of its own name", () => {
    write("lib/orders/__init__.py");
    write(
      "pyproject.toml",
      '[tool.setuptools.package-dir]\norders = "lib/orders"\n',
    );
    expect(rootsUnder(dir)).toEqual(["lib"]);
  });

  it("skips a package mapped to a directory with another name", () => {
    write("lib/code/__init__.py");
    write(
      "pyproject.toml",
      '[tool.setuptools.package-dir]\norders = "lib/code"\n',
    );
    expect(rootsUnder(dir)).toEqual([]);
  });

  it("ignores a declared directory outside the project or missing from disk", () => {
    write(
      "pyproject.toml",
      '[tool.setuptools.packages.find]\nwhere = ["../elsewhere", "missing"]\n',
    );
    expect(rootsUnder(dir)).toEqual([]);
  });

  it("says which roots imports resolve against when a manifest could not be read", () => {
    const project = path.join(FIXTURES, "unreadable-toml");
    const found = pythonSourceRoots(project);
    const text = formatUnreadSourceRoots(found, project, [
      project,
      ...found.roots,
    ]);
    expect(text).toContain("Could not read pyproject.toml");
    expect(text).toContain("Absolute imports resolve against ., src.");
    expect(text.split("\n").filter((line) => line !== "")).toHaveLength(2);
  });

  it("prints nothing when every manifest was read", () => {
    const project = path.join(FIXTURES, "hatch");
    expect(
      formatUnreadSourceRoots(pythonSourceRoots(project), project, [project]),
    ).toBe("");
  });
});

describe("extract from the repository root of a project whose package is below it", () => {
  it.each([
    "setuptools-package-dir",
    "setuptools-find",
    "hatch",
    "poetry",
    "plain-src",
    "unreadable-toml",
  ])("mounts the router of %s at its full path", async (name) => {
    const project = path.join(dir, name);
    fs.cpSync(path.join(FIXTURES, name), project, { recursive: true });

    const summaries = await extract({
      dir: project,
      frameworks: ["fastapi"],
      output: path.join(dir, "summaries.json"),
      noCache: true,
    });

    expect(
      summaries.map((s) => [
        s.identity.name,
        s.identity.boundaryBinding?.semantics,
      ]),
    ).toEqual([
      ["read_order", expect.objectContaining({ path: "/orders/{order_id}" })],
    ]);
  });

  // The cache turns itself off when the adapter is loaded from source,
  // so only the built binary reaches it.
  it("does not serve a cached run once pyproject.toml moves the source root", () => {
    const project = path.join(dir, "moved");
    fs.cpSync(path.join(FIXTURES, "setuptools-package-dir"), project, {
      recursive: true,
    });
    const pyproject = path.join(project, "pyproject.toml");
    const declared = fs.readFileSync(pyproject, "utf8");
    fs.writeFileSync(pyproject, '[project]\nname = "orders"\n');

    const paths = (): unknown[] => {
      const result = spawnSync(
        process.execPath,
        [BIN, "extract", "-f", "fastapi", "-o", "out.json"],
        { cwd: project, encoding: "utf8", timeout: 180_000 },
      );
      if (result.status !== 0) {
        throw new Error(`extract failed: ${result.stderr}`);
      }
      const summaries = JSON.parse(
        fs.readFileSync(path.join(project, "out.json"), "utf8"),
      ) as Array<{ identity: { boundaryBinding?: { semantics: unknown } } }>;
      return summaries.map(
        (s) =>
          (s.identity.boundaryBinding?.semantics as { path?: unknown })?.path,
      );
    };

    expect(paths()).toEqual([null]);
    fs.writeFileSync(pyproject, declared);
    expect(paths()).toEqual(["/orders/{order_id}"]);
  }, 300_000);

  it("abstains when the package is both at the root and under src", async () => {
    const project = path.join(dir, "both");
    fs.cpSync(path.join(FIXTURES, "plain-src"), project, { recursive: true });
    fs.cpSync(
      path.join(project, "src", "orders"),
      path.join(project, "orders"),
      { recursive: true },
    );

    const summaries = await extract({
      dir: project,
      frameworks: ["fastapi"],
      output: path.join(dir, "summaries.json"),
      noCache: true,
    });

    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(summary.identity.boundaryBinding?.semantics).toEqual(
        expect.objectContaining({ path: null }),
      );
    }
  });
});
