import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "./project.js";
import { pythonSourceRoots, readTomlFile } from "./sourceRoots.js";

import type { PythonPack } from "./pack.js";

const FIXTURES = path.resolve(
  __dirname,
  "../../../../fixtures/python-source-roots",
);

/** A fastapi-shaped pack, written here rather than imported, because an adapter does not depend on a pack. */
const fastapiLike: PythonPack = {
  name: "fastapi-test",
  protocol: "http",
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      verbAttributeNames: { get: "GET" },
      pathParamSyntax: "braces",
      routerComposition: {
        routerConstructorName: "APIRouter",
        includeMethodName: "include_router",
        prefixKeyword: "prefix",
      },
    },
  ],
};

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

/** The roots after the project directory, which always comes first. */
function sourceDirectoriesOf(project: string): string[] {
  const { roots } = pythonSourceRoots(project);
  expect(roots[0]).toBe(path.resolve(project));
  return roots.slice(1).map((root) => path.relative(project, root));
}

const FIXTURE_ROOTS: Array<[string, string]> = [
  ["setuptools-package-dir", "lib"],
  ["setuptools-find", "lib"],
  ["hatch", "lib"],
  ["poetry", "lib"],
  ["plain-src", "src"],
  ["unreadable-toml", "src"],
];

describe("pythonSourceRoots", () => {
  it.each(FIXTURE_ROOTS)(
    "finds the source directory of %s",
    (name, expected) => {
      expect(sourceDirectoriesOf(path.join(FIXTURES, name))).toEqual([
        expected,
      ]);
    },
  );

  it("names the pyproject it could not read, and still falls back to src", () => {
    const found = pythonSourceRoots(path.join(FIXTURES, "unreadable-toml"));
    expect(found.unread).toEqual([
      {
        where: "pyproject.toml",
        reason: expect.stringContaining("not valid TOML"),
      },
    ]);
  });

  it("gives a one-line reason that says where the file went wrong", () => {
    const read = readTomlFile(
      path.join(FIXTURES, "unreadable-toml", "pyproject.toml"),
    );
    expect(read.kind).toBe("unreadable");
    const reason = read.kind === "unreadable" ? read.reason : "";
    expect(reason).not.toContain("\n");
    expect(reason).toMatch(/\(line 9\)$/);
  });

  it("reads a dependency group that mixes an include table and strings", () => {
    write(
      "pyproject.toml",
      '[dependency-groups]\ntest = ["pytest"]\ndev = [{ include-group = "test" }, "ruff"]\n',
    );
    expect(readTomlFile(path.join(dir, "pyproject.toml")).kind).toBe("parsed");
  });

  it("adds nothing for a project with its package at the root", () => {
    write("orders/__init__.py");
    write("pyproject.toml", '[project]\nname = "orders"\n');
    expect(pythonSourceRoots(dir)).toEqual({
      roots: [path.resolve(dir)],
      unread: [],
    });
  });

  it("leaves src alone when it is a package itself", () => {
    write("src/__init__.py");
    write("src/orders/__init__.py");
    expect(sourceDirectoriesOf(dir)).toEqual([]);
  });

  it("leaves src alone when nothing under it is a package", () => {
    write("src/app.py");
    expect(sourceDirectoriesOf(dir)).toEqual([]);
  });

  it("prefers a declared directory over src", () => {
    write("src/tools/__init__.py");
    write("lib/orders/__init__.py");
    write(
      "pyproject.toml",
      '[tool.poetry]\npackages = [{ include = "orders", from = "lib" }]\n',
    );
    expect(sourceDirectoriesOf(dir)).toEqual(["lib"]);
  });

  it("reads a package mapped to a directory of its own name", () => {
    write("lib/orders/__init__.py");
    write(
      "pyproject.toml",
      '[tool.setuptools.package-dir]\norders = "lib/orders"\n',
    );
    expect(sourceDirectoriesOf(dir)).toEqual(["lib"]);
  });

  it("skips a package mapped to a directory with another name", () => {
    write("lib/code/__init__.py");
    write(
      "pyproject.toml",
      '[tool.setuptools.package-dir]\norders = "lib/code"\n',
    );
    expect(sourceDirectoriesOf(dir)).toEqual([]);
  });

  it("ignores a declared directory outside the project or missing from disk", () => {
    write(
      "pyproject.toml",
      '[tool.setuptools.packages.find]\nwhere = ["../elsewhere", "missing"]\n',
    );
    expect(sourceDirectoriesOf(dir)).toEqual([]);
  });
});

describe("extractPythonProject from the directory above the package", () => {
  async function extractFrom(project: string) {
    return extractPythonProject({
      files: findPythonFiles(project),
      packs: [fastapiLike],
      projectRoot: project,
      cacheDir: null,
    });
  }

  it.each(FIXTURE_ROOTS)(
    "mounts the router of %s at its full path",
    async (name) => {
      const project = path.join(FIXTURES, name);
      const { summaries } = await extractFrom(project);

      expect(
        summaries.map((s) => [
          s.identity.name,
          s.identity.boundaryBinding?.semantics,
        ]),
      ).toEqual([
        ["read_order", expect.objectContaining({ path: "/orders/{order_id}" })],
      ]);
    },
  );

  it("returns the roots it used and the manifest it could not read", async () => {
    const project = path.join(FIXTURES, "unreadable-toml");
    const result = await extractFrom(project);

    expect(result.roots).toEqual([project, path.join(project, "src")]);
    expect(result.unreadManifests.map((m) => m.where)).toEqual([
      "pyproject.toml",
    ]);
  });

  it("uses the roots it is given instead of reading them", async () => {
    const project = path.join(FIXTURES, "plain-src");
    const result = await extractPythonProject({
      files: findPythonFiles(project),
      packs: [fastapiLike],
      roots: [project],
      projectRoot: project,
      cacheDir: null,
    });

    expect(result.roots).toEqual([project]);
    expect(
      result.summaries.map((s) => s.identity.boundaryBinding?.semantics),
    ).toEqual([expect.objectContaining({ path: null })]);
  });

  it("abstains when the package is both at the root and under src", async () => {
    const project = path.join(dir, "both");
    fs.cpSync(path.join(FIXTURES, "plain-src"), project, { recursive: true });
    fs.cpSync(
      path.join(project, "src", "orders"),
      path.join(project, "orders"),
      { recursive: true },
    );

    const { summaries } = await extractFrom(project);

    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(summary.identity.boundaryBinding?.semantics).toEqual(
        expect.objectContaining({ path: null }),
      );
    }
  });

  it("asks for roots or a project root when given neither", async () => {
    await expect(
      extractPythonProject({ files: [], packs: [fastapiLike] }),
    ).rejects.toThrow(/needs roots, or a projectRoot/);
  });
});
