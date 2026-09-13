import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { summaryIdentifier } from "@suss/behavioral-ir";
import { Database } from "@suss/datalog";
import { addPackWords } from "@suss/resolution";

import {
  extractPythonProject,
  findPythonFiles,
  packWordsOf,
} from "./project.js";

import type { ExtractionReport, TimingReport } from "@suss/extractor";
import type { PyModelQueries, PythonPack } from "./pack.js";

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

describe("a configured wrapper module nothing imports", () => {
  it("says which entry missed, and stays quiet about the one a file imports", async () => {
    write(
      "myapp/wrappers/restx.py",
      "from flask_restx import Namespace\n\napi = Namespace('app')\n\n\ndef route(path):\n    return api.route(path)\n",
    );
    const todos = write(
      "myapp/routes/todos.py",
      'from myapp.wrappers.restx import route\n\n\n@route("/todos")\nclass TodoList:\n    def get(self):\n        return []\n',
    );
    const said: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await extractPythonProject({
        files: [todos],
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

    const complaints = said.filter((line) => line.includes("changes nothing"));
    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toContain("myapp.wrappers.typo");
  });
});

const fastapiLike: PythonPack = {
  name: "fastapi-test",
  protocol: "http",
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      verbAttributeNames: { get: "GET", post: "POST" },
      pathParamSyntax: "braces",
      annotatedClassIsRequestBody: true,
      injectedParameterCallees: ["Depends", "Security"],
      defaultStatusCode: 200,
    },
  ],
};

describe("a parameter annotated with a name from another file", () => {
  async function rolesOf(
    files: Record<string, string>,
  ): Promise<Record<string, [string, string | null][]>> {
    const paths = Object.entries(files).map(([rel, content]) =>
      write(rel, content),
    );
    const { summaries } = await extractPythonProject({
      files: paths,
      roots: [tmpDir],
      packs: [fastapiLike],
      workspaceRoot: tmpDir,
    });
    const out: Record<string, [string, string | null][]> = {};
    for (const summary of summaries) {
      if (summary.kind !== "handler") {
        continue;
      }
      out[summary.identity.name] = summary.inputs.flatMap((input) =>
        input.type === "parameter" ? [[input.name, input.role]] : [],
      );
    }
    return out;
  }

  it("reads an imported model as the request body, with its fields", async () => {
    const roles = await rolesOf({
      "app/models.py": "class ItemCreate:\n    title: str\n    count: int\n",
      "app/routes.py": [
        "from fastapi import FastAPI",
        "from app.models import ItemCreate",
        "",
        "app = FastAPI()",
        "",
        "",
        '@app.post("/items")',
        "def create_item(item_in: ItemCreate):",
        "    pass",
        "",
      ].join("\n"),
    });
    expect(roles.create_item).toEqual([["item_in", "requestBody"]]);
  });

  it("follows a model re-exported through a package's __init__", async () => {
    const roles = await rolesOf({
      "app/models/item.py": "class ItemCreate:\n    title: str\n",
      "app/models/__init__.py": "from .item import ItemCreate\n",
      "app/routes.py": [
        "from fastapi import FastAPI",
        "from app.models import ItemCreate",
        "",
        "app = FastAPI()",
        "",
        "",
        '@app.post("/items")',
        "def create_item(item_in: ItemCreate):",
        "    pass",
        "",
      ].join("\n"),
    });
    expect(roles.create_item).toEqual([["item_in", "requestBody"]]);
  });

  it("reads an injector written inside an imported Annotated alias as injected", async () => {
    const roles = await rolesOf({
      "app/deps.py": [
        "from typing import Annotated",
        "from fastapi import Depends",
        "from sqlmodel import Session",
        "",
        "",
        "def get_db():",
        "    pass",
        "",
        "",
        "def get_current_user():",
        "    pass",
        "",
        "",
        "class User:",
        "    id: int",
        "",
        "",
        "SessionDep = Annotated[Session, Depends(get_db)]",
        "CurrentUser = Annotated[User, Depends(get_current_user)]",
        "",
      ].join("\n"),
      "app/routes.py": [
        "from fastapi import FastAPI",
        "from app.deps import CurrentUser, SessionDep",
        "",
        "app = FastAPI()",
        "",
        "",
        '@app.get("/items/{item_id}")',
        "def read_item(session: SessionDep, current_user: CurrentUser, item_id: int, q: str):",
        "    pass",
        "",
      ].join("\n"),
    });
    expect(roles.read_item).toEqual([
      ["session", null],
      ["current_user", null],
      ["item_id", "pathParams"],
      ["q", "queryParams"],
    ]);
  });

  it("reads an Annotated alias written in the route's own file the same way", async () => {
    const roles = await rolesOf({
      "app/routes.py": [
        "from typing import Annotated",
        "from fastapi import Depends, FastAPI",
        "",
        "app = FastAPI()",
        "",
        "",
        "def get_db():",
        "    pass",
        "",
        "",
        "SessionDep = Annotated[object, Depends(get_db)]",
        "",
        "",
        '@app.get("/items")',
        "def list_items(session: SessionDep, q: str):",
        "    pass",
        "",
      ].join("\n"),
    });
    expect(roles.list_items).toEqual([
      ["session", null],
      ["q", "queryParams"],
    ]);
  });

  it("does not blame the path when an injected parameter is the only one without a role", async () => {
    const routes = write(
      "app/routes.py",
      [
        "from typing import Annotated",
        "from fastapi import Depends, FastAPI",
        "",
        "app = FastAPI()",
        "",
        "",
        "def get_db():",
        "    pass",
        "",
        "",
        '@app.get("/items")',
        "def list_items(session: Annotated[object, Depends(get_db)]):",
        "    pass",
        "",
      ].join("\n"),
    );
    const { summaries } = await extractPythonProject({
      files: [routes],
      roots: [tmpDir],
      packs: [fastapiLike],
      workspaceRoot: tmpDir,
    });
    const route = summaries.find((s) => s.identity.name === "list_items");
    expect(
      route?.inputs.map((input) =>
        input.type === "parameter" ? input.role : input.type,
      ),
    ).toEqual([null]);
    expect(
      route?.gaps.filter((gap) => gap.description.includes("name no role")),
    ).toEqual([]);
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

  it("stamps an empty list on a file that imports nothing in the project, so a handler entry there is a leaf of the graph", async () => {
    const only = write(
      "myapp/worker.py",
      'import os\nimport boto3\n\nQUEUE_URL = os.environ["QUEUE_URL"]\n',
    );
    const { summaries } = await extractPythonProject({
      files: [only],
      roots: [tmpDir],
      packs: [flaskRestxLike],
      workspaceRoot: tmpDir,
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.metadata?.moduleImports).toEqual([]);
  });
});

describe("a status a handler returns as a name another module writes", () => {
  const flaskRestxWithReturnStatus: PythonPack = {
    ...flaskRestxLike,
    discovery: [
      {
        ...flaskRestxLike.discovery[0],
        statusFromReturnedTuple: true,
      } as PythonPack["discovery"][number],
    ],
  };

  it("reads the number the constant was written as", async () => {
    write(
      "myapp/wrappers/restx.py",
      "from flask_restx import Namespace\n\napi = Namespace('app')\n\n\ndef route(path):\n    return api.route(path)\n",
    );
    const http = write("myapp/http.py", "HTTP_201 = 201\n");
    const todos = write(
      "myapp/routes/todos.py",
      [
        "from myapp.wrappers.restx import route",
        "from myapp.http import HTTP_201",
        "",
        "",
        '@route("/todos")',
        "class TodoList:",
        "    def post(self):",
        '        return {"a": 1}, HTTP_201',
        "",
      ].join("\n"),
    );

    const { summaries } = await extractPythonProject({
      files: [http, todos],
      roots: [tmpDir],
      packs: [flaskRestxWithReturnStatus],
      workspaceRoot: tmpDir,
    });
    const route = summaries.find((s) => s.kind === "handler");
    expect(
      route?.transitions.map((transition) =>
        transition.output.type === "response"
          ? transition.output.statusCode
          : null,
      ),
    ).toEqual([{ type: "literal", value: 201 }]);
  });
});

describe("environment reads on a summary", () => {
  it("puts a route body's reads on the route and a module's reads on a module-init unit", async () => {
    const wrapper = write(
      "myapp/wrappers/restx.py",
      "from flask_restx import Namespace\n\napi = Namespace('app')\n\n\ndef route(path):\n    return api.route(path)\n",
    );
    const todos = write(
      "myapp/routes/todos.py",
      [
        "import os",
        "from myapp.wrappers.restx import route",
        "",
        'TABLE = os.environ["TABLE_NAME"]',
        "",
        "",
        '@route("/todos")',
        "class TodoList:",
        "    def get(self):",
        '        limit = os.environ.get("PAGE_SIZE", "20")',
        "        return []",
        "",
      ].join("\n"),
    );
    const { summaries } = await extractPythonProject({
      files: [wrapper, todos],
      roots: [tmpDir],
      packs: [flaskRestxLike],
      workspaceRoot: tmpDir,
    });

    const configReads = (summary: (typeof summaries)[number] | undefined) =>
      summary?.transitions.flatMap((t) =>
        t.effects.flatMap((effect) =>
          effect.type === "interaction" &&
          effect.interaction.class === "config-read"
            ? [effect.interaction]
            : [],
        ),
      );
    const route = summaries.find((s) => s.kind === "handler");
    expect(configReads(route)).toEqual([
      { class: "config-read", name: "PAGE_SIZE", defaulted: true },
    ]);

    const moduleInit = summaries.find((s) => s.kind === "module-init");
    expect(moduleInit?.identity.name).toBe("todos.py");
    expect(moduleInit?.location.file).toBe("myapp/routes/todos.py");
    expect(configReads(moduleInit)).toEqual([
      { class: "config-read", name: "TABLE_NAME", defaulted: false },
    ]);
  });

  it("emits no module-init unit for a file that reads nothing at load", async () => {
    const wrapper = write(
      "myapp/wrappers/restx.py",
      "from flask_restx import Namespace\n\napi = Namespace('app')\n\n\ndef route(path):\n    return api.route(path)\n",
    );
    const only = write(
      "myapp/routes/solo.py",
      'from myapp.wrappers.restx import route\n\n\n@route("/solo")\nclass Solo:\n    def get(self):\n        return []\n',
    );
    const { summaries } = await extractPythonProject({
      files: [wrapper, only],
      roots: [tmpDir],
      packs: [flaskRestxLike],
      workspaceRoot: tmpDir,
    });
    expect(summaries.map((s) => s.kind)).toEqual(["handler"]);
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

  it("composes a router's path across files, reading a prefix a function returns and abstaining where a call nobody can follow supplies it", async () => {
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
    const reports = write(
      "shop/routers/reports.py",
      [
        "from fastapi import APIRouter",
        "",
        'router = APIRouter(prefix="/reports")',
        "",
        "",
        '@router.get("/daily")',
        "def daily_report():",
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
        "from shop.routers.reports import router as reports_router",
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
        "app.include_router(reports_router, prefix=admin_prefix().upper())",
        "",
      ].join("\n"),
    );

    const { summaries } = await extractPythonProject({
      files: [admin, items, reports, main],
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
      path: "/internal/admin/stats",
    });

    const dailyReport = summaries.find(
      (s) => s.identity.name === "daily_report",
    );
    expect(dailyReport?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: null,
    });
    expect(
      dailyReport?.gaps.some(
        (gap) =>
          gap.type === "unreadOutcome" &&
          gap.description.includes("not a string literal"),
      ),
    ).toBe(true);
  });

  it("composes the prefix of a router a project wrapper function returns", async () => {
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
    const routers = write(
      "shop/routers.py",
      [
        "from fastapi import APIRouter",
        "",
        "def build_items_router():",
        '    return APIRouter(prefix="/items")',
        "",
      ].join("\n"),
    );
    const items = write(
      "shop/items.py",
      [
        "from shop.routers import build_items_router",
        "",
        "router = build_items_router()",
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
      ].join("\n"),
    );
    const main = write(
      "shop/main.py",
      [
        "from fastapi import FastAPI",
        "",
        "from shop.items import router as items_router",
        "",
        "app = FastAPI()",
        "",
        'app.include_router(items_router, prefix="/api")',
        "",
      ].join("\n"),
    );

    const { summaries } = await extractPythonProject({
      files: [routers, items, main],
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
  });

  it("abstains as unmounted when nothing mounts a router a project wrapper function returns", async () => {
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
    const routers = write(
      "shop/routers.py",
      [
        "from fastapi import APIRouter",
        "",
        "def build_items_router():",
        '    return APIRouter(prefix="/items")',
        "",
      ].join("\n"),
    );
    const items = write(
      "shop/items.py",
      [
        "from shop.routers import build_items_router",
        "",
        "router = build_items_router()",
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
      ].join("\n"),
    );

    const { summaries } = await extractPythonProject({
      files: [routers, items],
      packs: [fastapiLike],
      roots: [tmpDir],
      workspaceRoot: tmpDir,
    });

    const readItem = summaries.find((s) => s.identity.name === "read_item");
    expect(readItem?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: null,
    });
    expect(
      readItem?.gaps.some(
        (gap) =>
          gap.type === "unreadOutcome" &&
          gap.description.includes(
            "is never mounted through a single variable binding in the files read",
          ),
      ),
    ).toBe(true);
  });

  it("reads the prefix a router a project wrapper function returns gets from another function", async () => {
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
    const routers = write(
      "shop/routers.py",
      [
        "from fastapi import APIRouter",
        "",
        "def items_prefix():",
        '    return "/items"',
        "",
        "def build_items_router():",
        "    return APIRouter(prefix=items_prefix())",
        "",
      ].join("\n"),
    );
    const items = write(
      "shop/items.py",
      [
        "from shop.routers import build_items_router",
        "",
        "router = build_items_router()",
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
      ].join("\n"),
    );
    const main = write(
      "shop/main.py",
      [
        "from fastapi import FastAPI",
        "",
        "from shop.items import router as items_router",
        "",
        "app = FastAPI()",
        "",
        'app.include_router(items_router, prefix="/api")',
        "",
      ].join("\n"),
    );

    const { summaries } = await extractPythonProject({
      files: [routers, items, main],
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
    expect(readItem?.gaps).toEqual([]);
  });

  it("reads a prefix a lambda builds", async () => {
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
      "shop/items.py",
      [
        "from fastapi import APIRouter",
        "",
        'versioned = lambda p: "/v1" + p',
        'router = APIRouter(prefix=versioned("/items"))',
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
      ].join("\n"),
    );
    const main = write(
      "shop/main.py",
      [
        "from fastapi import FastAPI",
        "",
        "from shop.items import router as items_router",
        "",
        "app = FastAPI()",
        "",
        'app.include_router(items_router, prefix="/api")',
        "",
      ].join("\n"),
    );

    const { summaries } = await extractPythonProject({
      files: [items, main],
      packs: [fastapiLike],
      roots: [tmpDir],
      workspaceRoot: tmpDir,
    });

    const readItem = summaries.find((s) => s.identity.name === "read_item");
    expect(readItem?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/api/v1/items/{item_id}",
    });
  });

  it("does not mount a router under a function parameter that shadows another router's own name", async () => {
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
    const main = write(
      "shop/main.py",
      [
        "from fastapi import FastAPI, APIRouter",
        "",
        "app = FastAPI()",
        "",
        'router = APIRouter(prefix="/items")',
        'other_router = APIRouter(prefix="/other")',
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
        "",
        "def register(router):",
        "    app.include_router(router)",
        "",
        "",
        "register(other_router)",
        "",
      ].join("\n"),
    );

    const { summaries } = await extractPythonProject({
      files: [main],
      packs: [fastapiLike],
      roots: [tmpDir],
      workspaceRoot: tmpDir,
    });

    const readItem = summaries.find((s) => s.identity.name === "read_item");
    expect(readItem?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: null,
    });
    expect(
      readItem?.gaps.some(
        (gap) =>
          gap.type === "unreadOutcome" &&
          gap.description.includes(
            "is never mounted through a single variable binding in the files read",
          ),
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

  it("discovers a route registered through a router a project wrapper builds", async () => {
    const fastapiLike: PythonPack = {
      name: "fastapi-test",
      protocol: "http",
      discovery: [
        {
          type: "decoratedFunctionRoute",
          importModule: ["fastapi"],
          verbAttributeNames: { get: "GET" },
        },
      ],
    };
    const routers = write(
      "shop/routers.py",
      [
        "from fastapi import APIRouter",
        "",
        "def build_items_router():",
        '    return APIRouter(prefix="/items")',
        "",
      ].join("\n"),
    );
    const items = write(
      "shop/items.py",
      [
        "from shop.routers import build_items_router",
        "",
        "router = build_items_router()",
        "",
        "",
        '@router.get("/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
      ].join("\n"),
    );

    const { summaries } = await extractPythonProject({
      files: [routers, items],
      packs: [fastapiLike],
      roots: [tmpDir],
      workspaceRoot: tmpDir,
    });

    const readItem = summaries.find((s) => s.identity.name === "read_item");
    expect(readItem?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/{item_id}",
    });
  });

  it("discovers a route on an app a guarded getter builds after writing None", async () => {
    const fastapiLike: PythonPack = {
      name: "fastapi-test",
      protocol: "http",
      discovery: [
        {
          type: "decoratedFunctionRoute",
          importModule: ["fastapi"],
          verbAttributeNames: { get: "GET" },
        },
      ],
    };
    const factory = write(
      "shop/factory.py",
      [
        "from fastapi import FastAPI",
        "",
        "_app = None",
        "",
        "",
        "def get_app():",
        "    global _app",
        "    if _app is None:",
        "        _app = FastAPI()",
        "    return _app",
        "",
      ].join("\n"),
    );
    const items = write(
      "shop/items.py",
      [
        "from shop.factory import get_app",
        "",
        "app = get_app()",
        "",
        "",
        '@app.get("/items/{item_id}")',
        "def read_item(item_id: int):",
        "    pass",
        "",
      ].join("\n"),
    );

    const { summaries } = await extractPythonProject({
      files: [factory, items],
      packs: [fastapiLike],
      roots: [tmpDir],
      workspaceRoot: tmpDir,
    });

    const readItem = summaries.find((s) => s.identity.name === "read_item");
    expect(readItem?.identity.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/items/{item_id}",
    });
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
        storageSystem: "postgresql",
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
        storageSystem: "postgresql",
      },
    ],
  };

  it("puts a service function's query on its own summary and links the route's call to it", async () => {
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

    const effectsOn = (kind: string) =>
      summaries
        .filter((summary) => summary.kind === kind)
        .flatMap((summary) =>
          summary.transitions.flatMap((transition) => transition.effects),
        );
    const storageOn = (kind: string) =>
      effectsOn(kind).filter(
        (effect) =>
          effect.type === "interaction" &&
          effect.interaction.class === "storage-access",
      );
    // The route reports only its own work; the query lives on the service
    // function's summary, and the call effect says which summary that is.
    expect(storageOn("handler")).toHaveLength(0);
    expect(storageOn("library")).toHaveLength(1);
    const helper = summaries.find((summary) => summary.kind === "library");
    const call = effectsOn("handler").find(
      (effect) =>
        effect.type === "invocation" && effect.callee === "load_orders",
    );
    expect(call?.type === "invocation" ? call.summary : null).toBe(
      helper === undefined ? null : summaryIdentifier(helper),
    );
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

describe("the extraction report", () => {
  it("counts files, units and summaries by pack, and times each phase", async () => {
    write(
      "myapp/wrappers/restx.py",
      "from flask_restx import Namespace\n\napi = Namespace('app')\n\n\ndef route(path):\n    return api.route(path)\n",
    );
    write(
      "myapp/routes/todos.py",
      'from myapp.wrappers.restx import route\n\n\n@route("/todos")\nclass TodoList:\n    def get(self):\n        return []\n',
    );
    write("myapp/routes/README.py", "# not a route\n");
    const files = [...findPythonFiles(tmpDir)];

    let report: ExtractionReport | undefined;
    let timing: TimingReport | undefined;
    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs: [
        {
          ...flaskRestxLike,
          projectModules: ["myapp.wrappers.restx"],
        },
      ],
      onExtractionReport: (r) => {
        report = r;
      },
      onTiming: (t) => {
        timing = t;
      },
    });

    expect(report?.filesWalked).toBe(files.length);
    expect(report?.summaries).toBe(1);
    const funnel = report?.packs.find((p) => p.pack === "flask-restx");
    expect(funnel?.gates).toEqual([]);
    expect(funnel?.candidateFiles).toBe(files.length);
    expect(funnel?.unitsDiscovered).toBe(1);
    expect(funnel?.summariesProduced).toBe(1);
    expect(funnel?.summariesBound).toBe(1);

    const phases = new Set(timing?.phases.map((phase) => phase.label));
    expect(phases).toEqual(
      new Set([
        "parse",
        "discover",
        "summarize",
        "cache.lookup",
        "cache.write",
      ]),
    );
  });

  it("blames discovery when files were found but no route matched", async () => {
    write("myapp/routes/todos.py", "def not_a_route():\n    return []\n");
    const files = [...findPythonFiles(tmpDir)];

    let report: ExtractionReport | undefined;
    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs: [flaskRestxLike],
      onExtractionReport: (r) => {
        report = r;
      },
    });

    expect(report?.summaries).toBe(0);
    expect(report?.emptyStage).toBe("discovery");
  });
});

/** The facts a run over these packs starts from, the way the extractor puts them there. */
function packFacts(packs: readonly PythonPack[]): Database {
  const db = new Database();
  addPackWords(db, packWordsOf(packs));
  return db;
}

describe("what a pack's model declarations put in the facts", () => {
  const packWithModels = (models: PyModelQueries[]): PythonPack => ({
    name: "sqlmodel",
    protocol: "postgresql",
    discovery: [],
    models,
  });

  it("pairs every method with every base name the declaration lists", () => {
    const db = packFacts([
      packWithModels([
        {
          baseNames: ["DeclarativeBase", "SQLModel"],
          givesBack: ["first"],
          entryMethods: [{ method: "get", argument: 0 }],
          entryFunctions: [{ module: "sqlmodel", name: "select", argument: 0 }],
        },
      ]),
    ]);

    expect(db.facts("givesBackOne").map((row) => row.map(String))).toEqual([
      ["DeclarativeBase", "first"],
      ["SQLModel", "first"],
    ]);
    expect(
      db.facts("givesBackOneOfArgument").map((row) => row.map(String)),
    ).toEqual([
      ["DeclarativeBase", "get", "0"],
      ["SQLModel", "get", "0"],
    ]);
  });

  it("keys a function called on its own by the module it comes from", () => {
    const db = packFacts([
      packWithModels([
        {
          baseNames: ["SQLModel"],
          givesBack: [],
          entryMethods: [],
          entryFunctions: [{ module: "sqlmodel", name: "select", argument: 0 }],
        },
      ]),
    ]);

    expect(
      db.facts("givesBackOneOfImport").map((row) => row.map(String)),
    ).toEqual([["sqlmodel", "select", "0"]]);
  });

  it("keys a relationship constructor by the module it comes from", () => {
    const db = packFacts([
      packWithModels([
        {
          baseNames: ["SQLModel"],
          givesBack: [],
          entryMethods: [],
          entryFunctions: [],
          relationships: [{ module: "sqlmodel", name: "Relationship" }],
        },
      ]),
    ]);

    expect(
      db.facts("associationConstructor").map((row) => row.map(String)),
    ).toEqual([["sqlmodel", "Relationship"]]);
  });

  it("says nothing for a pack that declares no models at all", () => {
    const db = packFacts([flaskRestxLike]);

    expect(db.size("givesBackOne")).toBe(0);
    expect(db.size("givesBackOneOfArgument")).toBe(0);
    expect(db.size("givesBackOneOfImport")).toBe(0);
    expect(db.size("associationConstructor")).toBe(0);
  });
});

describe("what a pack's context manager declarations put in the facts", () => {
  it("keys every class the declaration lists by its module", () => {
    const db = packFacts([
      {
        name: "httpx",
        protocol: "http",
        discovery: [],
        contextManagers: [
          { module: "httpx", returnsSelf: ["Client", "AsyncClient"] },
        ],
      },
    ]);

    expect(db.facts("entersAsSelf").map((row) => row.map(String))).toEqual([
      ["httpx", "Client"],
      ["httpx", "AsyncClient"],
    ]);
  });

  it("says nothing for a pack that declares no context manager at all", () => {
    const db = packFacts([flaskRestxLike]);

    expect(db.size("entersAsSelf")).toBe(0);
  });
});
