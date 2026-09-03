/**
 * The on-disk extraction cache, exercised against a temp directory.
 *
 * Running under vitest gives the adapter a "source" code stamp, and a
 * run from source always declines to cache. `./version.js` is mocked
 * here so `declineWhenRunFromSource` passes `cacheDir` through
 * unchanged. That is what puts the cache layer itself under test,
 * the same one a built CLI run reaches.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./version.js")>();
  return {
    ...actual,
    declineWhenRunFromSource: (cacheDir: string | null) => cacheDir,
  };
});

import { extractPythonProject, findPythonFiles } from "./project.js";

import type { CacheDiagnostic } from "@suss/extractor";
import type { PythonPack } from "./pack.js";

const flaskRestxLike: PythonPack = {
  name: "flask-restx",
  protocol: "http",
  discovery: [
    {
      type: "decoratedClassRoute",
      importModule: ["myapp.wrappers.restx"],
      decoratorName: "route",
      verbMethodNames: { get: "GET", post: "POST" },
    },
  ],
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-cache-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): string {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function routeProject(): string[] {
  write(
    "myapp/wrappers/restx.py",
    "from flask_restx import Namespace\n\napi = Namespace('app')\n\n\ndef route(path):\n    return api.route(path)\n",
  );
  write(
    "myapp/routes/todos.py",
    'from myapp.wrappers.restx import route\n\n\n@route("/todos")\nclass TodoList:\n    def get(self):\n        return []\n',
  );
  return findPythonFiles(tmpDir);
}

function testPacks(): PythonPack[] {
  return [{ ...flaskRestxLike, projectModules: ["myapp.wrappers.restx"] }];
}

describe("extractPythonProject's on-disk cache", () => {
  it("misses the first run and hits the second over unchanged files", async () => {
    const files = routeProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    const first = await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    const second = await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(first.summaries.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.kind).toBe("miss");
    expect(diagnostics[1]).toEqual({ kind: "hit" });
    expect(second.summaries).toEqual(first.summaries);
  });

  it("misses with files-changed once a walked file's content changes", async () => {
    const files = routeProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    write(
      "myapp/routes/todos.py",
      'from myapp.wrappers.restx import route\n\n\n@route("/todos")\nclass TodoList:\n    def get(self):\n        return [1]\n',
    );
    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(diagnostics[1]).toEqual({
      kind: "miss",
      missReason: "files-changed",
    });
  });

  it("misses with key-changed once a pack's declared version changes", async () => {
    const files = routeProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs: [{ ...packs[0], version: "2" }],
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(diagnostics[1]).toEqual({ kind: "miss", missReason: "key-changed" });
  });

  it("never writes an entry when cacheDir is null", async () => {
    const files = routeProject();
    const packs = testPacks();

    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      cacheDir: null,
    });
    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      cacheDir: null,
    });

    expect(fs.existsSync(path.join(tmpDir, ".suss", "cache"))).toBe(false);
  });
});
