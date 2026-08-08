import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  normalizePythonName,
  readInstallRequires,
  readPythonDependencies,
  readRubyDependencies,
} from "./dependencyManifests.js";

describe("readPythonDependencies", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-deps-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(relative: string, contents: string): void {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }

  function names(): string[] {
    return readPythonDependencies(dir)
      .named.map((dependency) => dependency.name)
      .sort();
  }

  it("reads a plain requirements file", () => {
    write("requirements.txt", "fastapi\nflask-restx\n");
    expect(names()).toEqual(["fastapi", "flask-restx"]);
  });

  it("reads a name out of everything a requirement line can carry", () => {
    write(
      "requirements.txt",
      [
        "# a comment",
        "",
        'flask[async]>=2.0 ; python_version < "3.9"',
        "fastapi==0.110.0",
        "Flask_RESTX~=1.3",
        "--index-url https://example.invalid/simple",
        "pydantic @ https://example.invalid/pydantic.whl",
      ].join("\n"),
    );
    expect(names()).toEqual(["fastapi", "flask", "flask-restx", "pydantic"]);
  });

  it("reads a line that continues onto the next", () => {
    write("requirements.txt", "fast\\\napi\n");
    expect(names()).toEqual(["fastapi"]);
  });

  it("follows an include, and a constraints file too", () => {
    write("requirements.txt", "-r base.txt\n-c constraints.txt\n");
    write("base.txt", "fastapi\n");
    write("constraints.txt", "pydantic==2.6.0\n");
    expect(names()).toEqual(["fastapi", "pydantic"]);
  });

  it("says so when an include names a file that is not there", () => {
    write("requirements.txt", "-r nowhere.txt\n");
    expect(readPythonDependencies(dir).unread[0]?.reason).toContain(
      "nowhere.txt",
    );
  });

  it("stops at a file that includes itself", () => {
    write("requirements.txt", "-r requirements.txt\nfastapi\n");
    expect(names()).toEqual(["fastapi"]);
  });

  it("records a URL install rather than dropping it", () => {
    write("requirements.txt", "https://example.invalid/wheels/thing.whl\n");
    const { named, unread } = readPythonDependencies(dir);
    expect(named).toEqual([]);
    expect(unread[0]?.reason).toContain("states no library name");
  });

  it("records an editable install, which names a path rather than a library", () => {
    write("requirements.txt", "-e ./libs/shared\n");
    expect(readPythonDependencies(dir).unread[0]?.reason).toContain(
      "installs from a path",
    );
  });

  it("reads the standard pyproject table", () => {
    write(
      "pyproject.toml",
      '[project]\nname = "svc"\ndependencies = ["fastapi>=0.110", "httpx"]\n',
    );
    expect(names()).toEqual(["fastapi", "httpx"]);
  });

  it("reads both of poetry's tables", () => {
    write(
      "pyproject.toml",
      [
        "[tool.poetry.dependencies]",
        'python = "^3.11"',
        'fastapi = "^0.110"',
        'flask-restx = { version = "^1.3" }',
        "",
        "[tool.poetry.dev-dependencies]",
        'pytest = "^8.0"',
      ].join("\n"),
    );
    // The interpreter itself is not a library anybody ships a pack for.
    expect(names()).toEqual(["fastapi", "flask-restx", "pytest"]);
  });

  it("says so when a project declares its dependencies dynamic", () => {
    write(
      "pyproject.toml",
      '[project]\nname = "svc"\ndynamic = ["dependencies"]\n',
    );
    expect(readPythonDependencies(dir).unread[0]?.reason).toContain("dynamic");
  });

  it("says so when pyproject will not parse", () => {
    write("pyproject.toml", "[project\n");
    expect(readPythonDependencies(dir).unread[0]?.reason).toContain("TOML");
  });

  it("reads Pipfile, which is TOML keyed by library name", () => {
    write(
      "Pipfile",
      '[packages]\nfastapi = "*"\n\n[dev-packages]\npytest = "*"\n',
    );
    expect(names()).toEqual(["fastapi", "pytest"]);
  });

  it("reads setup.cfg, the declarative sibling of setup.py", () => {
    write(
      "setup.cfg",
      "[options]\ninstall_requires =\n    fastapi>=0.110\n    httpx\n",
    );
    expect(names()).toEqual(["fastapi", "httpx"]);
  });

  it("reads a setup.py whose list is written out", () => {
    write(
      "setup.py",
      'setup(name="svc", install_requires=["fastapi", "httpx"])\n',
    );
    expect(names()).toEqual(["fastapi", "httpx"]);
  });

  it("says so when setup.py computes its list instead of writing one", () => {
    // Returning nothing here would look identical to a project with no
    // dependencies, which is the thing worth telling apart.
    write(
      "setup.py",
      "setup(name='svc', install_requires=read_requirements())\n",
    );
    const { named, unread } = readPythonDependencies(dir);
    expect(named).toEqual([]);
    expect(unread[0]?.reason).toContain("computed");
  });

  it("says so when a conda environment file is the only manifest", () => {
    write("environment.yml", "name: svc\n");
    expect(readPythonDependencies(dir).unread[0]?.reason).toContain("conda");
  });
});

describe("readInstallRequires", () => {
  it("reads a list of literals", () => {
    const reading = readInstallRequires('install_requires=["a", "b"]');
    expect(reading).toMatchObject({ kind: "written", value: ["a", "b"] });
  });

  it("abstains on a list that is partly built at run time", () => {
    const reading = readInstallRequires('install_requires=["a", *extras]');
    expect(reading.kind).toBe("unreadable");
  });

  it("is absent when the file states no install_requires at all", () => {
    expect(readInstallRequires("setup(name='svc')").kind).toBe("absent");
  });
});

describe("readRubyDependencies", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-deps-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the gems a lock file names as this project's own", () => {
    fs.writeFileSync(
      path.join(dir, "Gemfile.lock"),
      [
        "GEM",
        "  remote: https://rubygems.org/",
        "  specs:",
        "    graphql (2.3.5)",
        "    rack (3.0.0)",
        "",
        "DEPENDENCIES",
        "  graphql (~> 2.0)",
        "",
        "BUNDLED WITH",
        "   2.5.9",
      ].join("\n"),
    );
    // rack is something graphql pulled in, not something this project
    // asked for, so it is not evidence for a pack.
    expect(readRubyDependencies(dir).named.map((d) => d.name)).toEqual([
      "graphql",
    ]);
  });

  it("says why a Gemfile on its own is not read", () => {
    fs.writeFileSync(path.join(dir, "Gemfile"), 'gem "graphql"\n');
    const { named, unread } = readRubyDependencies(dir);
    expect(named).toEqual([]);
    expect(unread[0]?.reason).toContain("Gemfile.lock");
  });

  it("has nothing to say about a directory with neither", () => {
    expect(readRubyDependencies(dir)).toEqual({ named: [], unread: [] });
  });
});

describe("normalizePythonName", () => {
  it("makes one library out of the three ways pip lets you spell it", () => {
    expect(normalizePythonName("Flask-RESTX")).toBe("flask-restx");
    expect(normalizePythonName("flask_restx")).toBe("flask-restx");
    expect(normalizePythonName("flask.restx")).toBe("flask-restx");
  });
});
