import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { summaryIdentifier } from "@suss/behavioral-ir";

import { extractPythonProject, findPythonFiles } from "./project.js";

import type { ExtractionReport, TimingReport } from "@suss/extractor";
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
    expect(phases).toEqual(new Set(["parse", "discover", "summarize"]));
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
