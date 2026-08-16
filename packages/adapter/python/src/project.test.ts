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

describe("a configured wrapper module that resolves to nothing", () => {
  it("says which entry missed, and stays quiet when it resolves", async () => {
    write(
      "myapp/wrappers/restx.py",
      "from flask_restx import Namespace\n\napi = Namespace('app')\n\n\ndef route(path):\n    return api.route(path)\n",
    );
    const file = write("myapp/routes/todos.py", "x = 1\n");
    const said: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await extractPythonProject({
        files: [file],
        roots: [tmpDir],
        packs: [
          {
            ...flaskRestxLike,
            projectModules: ["myapp.wrappers.restx", "myapp.wrappers.typo"],
          },
        ],
      });
    } finally {
      process.stderr.write = original;
    }

    const complaints = said.filter((line) => line.includes("does not resolve"));
    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toContain("myapp.wrappers.typo");
  });
});

describe("module imports on a summary", () => {
  it("records the project files a summary's own file imports", async () => {
    write(
      "myapp/wrappers/restx.py",
      "from flask_restx import Namespace\n\napi = Namespace('app')\n\n\ndef route(path):\n    return api.route(path)\n",
    );
    const todos = write(
      "myapp/routes/todos.py",
      'from myapp.wrappers.restx import route\n\n\n@route("/todos")\nclass TodoList:\n    def get(self):\n        return []\n',
    );

    const { summaries } = await extractPythonProject({
      files: [path.join(tmpDir, "myapp/wrappers/restx.py"), todos],
      roots: [tmpDir],
      packs: [flaskRestxLike],
      workspaceRoot: tmpDir,
    });

    const route = summaries.find((s) =>
      s.location.file.endsWith("routes/todos.py"),
    );
    expect(route?.metadata?.moduleImports).toEqual(["myapp/wrappers/restx.py"]);
  });

  it("leaves the field off a file that imports nothing in the project", async () => {
    const only = write(
      "myapp/routes/solo.py",
      'from flask_restx import Namespace\n\napi = Namespace("solo")\n\n\n@api.route("/solo")\nclass Solo:\n    def get(self):\n        return []\n',
    );
    const { summaries } = await extractPythonProject({
      files: [only],
      roots: [tmpDir],
      packs: [flaskRestxLike],
      workspaceRoot: tmpDir,
    });
    expect(summaries[0]?.metadata?.moduleImports).toBeUndefined();
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

  it("composes a router's path across files, and abstains where a prefix is computed", async () => {
    const fastapiLike: PythonPack = {
      name: "fastapi-test",
      protocol: "http",
      discovery: [
        {
          type: "decoratedFunctionRoute",
          importModule: ["fastapi"],
          verbAttributeNames: { get: "GET" },
          routerComposition: {
            routerConstructorName: "APIRouter",
            includeMethodName: "include_router",
            prefixKeyword: "prefix",
          },
        },
      ],
    };
    const items = write(
      "shop/routers/items.py",
      [
        "from fastapi import APIRouter",
        "",
        'router = APIRouter(prefix="/items")',
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
      ].join("\n"),
    );
    const admin = write(
      "shop/routers/admin.py",
      [
        "from fastapi import APIRouter",
        "",
        'router = APIRouter(prefix="/admin")',
        "",
        "",
        '@router.get("/stats")',
        "def admin_stats():",
        "    pass",
        "",
      ].join("\n"),
    );
    const main = write(
      "shop/main.py",
      [
        "from fastapi import FastAPI",
        "",
        "from shop.routers.admin import router as admin_router",
        "from shop.routers.items import router as items_router",
        "",
        "app = FastAPI()",
        "",
        "",
        "def admin_prefix():",
        '    return "/internal"',
        "",
        "",
        'app.include_router(items_router, prefix="/api")',
        "app.include_router(admin_router, prefix=admin_prefix())",
        "",
      ].join("\n"),
    );

    const { summaries } = await extractPythonProject({
      files: [admin, items, main],
      packs: [fastapiLike],
      roots: [tmpDir],
      workspaceRoot: tmpDir,
    });

    const readItem = summaries.find((s) => s.identity.name === "read_item");
    expect(readItem?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/api/items/{item_id}",
    });

    const adminStats = summaries.find((s) => s.identity.name === "admin_stats");
    expect(adminStats?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: null,
    });
    expect(
      adminStats?.gaps.some(
        (gap) =>
          gap.type === "unreadOutcome" &&
          gap.description.includes("not a string literal"),
      ),
    ).toBe(true);
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

describe("a route whose body talks to the database", () => {
  const withStorage2: PythonPack = {
    ...flaskRestxLike,
    storage: [
      {
        module: "sqlalchemy",
        queryTypes: ["Select"],
        writes: ["update", "delete"],
        queryFunctions: ["select"],
        storageSystem: "postgres",
      },
    ],
  };

  const withStorage: PythonPack = {
    ...flaskRestxLike,
    storage: [
      {
        module: "sqlalchemy.orm",
        queryTypes: ["Query"],
        writes: ["update", "delete"],
        storageSystem: "postgres",
      },
    ],
  };

  it("follows a handler into a service function that builds a query from an imported constructor", async () => {
    write(
      "myapp/wrappers/restx.py",
      "from flask_restx import Namespace\n\napi = Namespace('app')\n\n\ndef route(path):\n    return api.route(path)\n",
    );
    write(
      "myapp/services.py",
      [
        "from sqlalchemy import select",
        "",
        "def load_orders():",
        "    return select(Orders.id).all()",
        "",
      ].join("\n"),
    );
    write(
      "myapp/routes/todos.py",
      [
        "from myapp.wrappers.restx import route",
        "from myapp.services import load_orders",
        "",
        '@route("/todos")',
        "class TodoList:",
        "    def get(self):",
        "        return load_orders()",
        "",
      ].join("\n"),
    );

    const { summaries } = await extractPythonProject({
      files: [...findPythonFiles(tmpDir)],
      packs: [withStorage2],
      roots: [tmpDir],
    });

    const storage = summaries
      .flatMap((summary) =>
        (summary.transitions ?? []).flatMap((transition) => transition.effects),
      )
      .filter(
        (effect) =>
          effect.type === "interaction" &&
          effect.interaction.class === "storage-access",
      );
    expect(storage).toHaveLength(1);
  });

  it("puts the database work on the route's own transitions", async () => {
    write(
      "myapp/wrappers/restx.py",
      "from flask_restx import Namespace\n\napi = Namespace('app')\n\n\ndef route(path):\n    return api.route(path)\n",
    );
    write(
      "myapp/models.py",
      [
        "from sqlalchemy.orm import Query",
        "",
        "class Base:",
        "    @classmethod",
        "    def query(cls) -> Query:",
        "        return session()",
        "",
        "class Orders(Base):",
        "    pass",
        "",
      ].join("\n"),
    );
    write(
      "myapp/routes/todos.py",
      [
        "from myapp.wrappers.restx import route",
        "from myapp.models import Orders",
        "",
        '@route("/todos")',
        "class TodoList:",
        "    def get(self):",
        "        return Orders.query().filter_by(id=1).first()",
        "",
      ].join("\n"),
    );

    const { summaries } = await extractPythonProject({
      files: [...findPythonFiles(tmpDir)],
      packs: [withStorage],
      roots: [tmpDir],
    });

    const effects = summaries.flatMap((summary) =>
      (summary.transitions ?? []).flatMap((transition) => transition.effects),
    );
    const storage = effects.filter(
      (effect) =>
        effect.type === "interaction" &&
        effect.interaction.class === "storage-access",
    );
    expect(storage).toHaveLength(1);
  });
});
