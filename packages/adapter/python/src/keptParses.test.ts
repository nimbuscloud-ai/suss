/**
 * A run given the trees an earlier run left has to say what a run that
 * parsed everything says. A process that reads a project after every
 * edit keeps one holder, and only the files whose text changed are
 * parsed again.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  extractPythonProject,
  findPythonFiles,
  keptPythonParses,
  parsePythonAhead,
} from "./project.js";

import type { PythonPack } from "./pack.js";

const packs: PythonPack[] = [
  {
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
    projectModules: ["myapp.wrappers.restx"],
  },
];

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-kept-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function todos(returned: string): string {
  return `from myapp.wrappers.restx import route\n\n\n@route("/todos")\nclass TodoList:\n    def get(self):\n        return ${returned}\n`;
}

function routeProject(): string[] {
  write(
    "myapp/wrappers/restx.py",
    "from flask_restx import Namespace\n\napi = Namespace('app')\n\n\ndef route(path):\n    return api.route(path)\n",
  );
  write("myapp/routes/todos.py", todos("[]"));
  return findPythonFiles(tmpDir);
}

async function run(
  files: string[],
  keptParses?: ReturnType<typeof keptPythonParses>,
) {
  const { summaries } = await extractPythonProject({
    files,
    roots: [tmpDir],
    packs,
    projectRoot: tmpDir,
    cacheDir: null,
    ...(keptParses !== undefined ? { keptParses } : {}),
  });
  return JSON.stringify(summaries);
}

describe("a Python run with kept parses", () => {
  it("says what a run that parsed everything says, after an edit", async () => {
    const files = routeProject();
    const kept = keptPythonParses();
    const before = await run(files, kept);

    write("myapp/routes/todos.py", todos("[1]"));
    const after = await run(files, kept);

    expect(after).not.toEqual(before);
    expect(after).toEqual(await run(files));
  });

  it("serves a run from trees parsed ahead of it", async () => {
    const files = routeProject();
    const kept = keptPythonParses();
    await parsePythonAhead(files, kept);

    expect(await run(files, kept)).toEqual(await run(files));
  });
});
