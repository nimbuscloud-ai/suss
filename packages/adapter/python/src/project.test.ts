import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "./project.js";

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-project-"));
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

describe("findPythonFiles", () => {
  it("finds every .py file under a root, skipping non-source directories", () => {
    write("myapp/routes/todos.py", "");
    write("myapp/__pycache__/todos.cpython-311.pyc", "");
    write("myapp/routes/README.md", "");
    const found = findPythonFiles(tmpDir).map((f) => path.relative(tmpDir, f));
    expect(found).toEqual(["myapp/routes/todos.py"]);
  });
});

describe("extractPythonProject", () => {
  it("extracts summaries across multiple files sharing one wrapper import", async () => {
    write(
      "myapp/wrappers/restx.py",
      "from flask_restx import Namespace\n\napi = Namespace('app')\n\n\ndef route(path):\n    return api.route(path)\n",
    );
    const todos = write(
      "myapp/routes/todos.py",
      'from myapp.wrappers.restx import route\n\n\n@route("/todos")\nclass TodoList:\n    def get(self):\n        return []\n',
    );
    const orders = write(
      "myapp/routes/orders.py",
      'from myapp.wrappers.restx import route as api_route\n\n\n@api_route("/orders")\nclass OrderList:\n    def get(self):\n        return []\n',
    );

    const { summaries, facts } = await extractPythonProject({
      files: [todos, orders],
      packs: [flaskRestxLike],
      roots: [tmpDir],
      workspaceRoot: tmpDir,
    });

    expect(summaries.map((s) => s.identity.name).sort()).toEqual([
      "OrderList.get",
      "TodoList.get",
    ]);
    expect(summaries.every((s) => s.confidence.level === "low")).toBe(true);
    expect(summaries.map((s) => s.location.file).sort()).toEqual(
      ["myapp/routes/orders.py", "myapp/routes/todos.py"].sort(),
    );

    expect(facts.facts("entry")).toHaveLength(2);
    const importedModules = facts.facts("pyImport").map((tuple) => tuple[1]);
    expect(importedModules).toContain("myapp.wrappers.restx");
  });

  it("produces no units for a file whose decorator resolves to nothing configured", async () => {
    const file = write(
      "myapp/routes/unrelated.py",
      'def f():\n    return "not a route"\n',
    );
    const { summaries } = await extractPythonProject({
      files: [file],
      packs: [flaskRestxLike],
      roots: [tmpDir],
    });
    expect(summaries).toEqual([]);
  });

  it("keeps location.file absolute when no workspaceRoot is given", async () => {
    const todos = write(
      "myapp/routes/todos.py",
      'from myapp.wrappers.restx import route\n\n\n@route("/todos")\nclass TodoList:\n    def get(self):\n        return []\n',
    );
    const { summaries } = await extractPythonProject({
      files: [todos],
      packs: [flaskRestxLike],
      roots: [tmpDir],
    });
    expect(summaries[0]?.location.file).toBe(todos);
  });
});
