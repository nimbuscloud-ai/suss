import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { classifyDecorator } from "./decorators.js";
import { emitValueFacts } from "./facts/values.js";
import { emitModuleImportFacts } from "./facts.js";
import { parsePython } from "./parser.js";
import { bindModule } from "./scope.js";
import { bindEvaluator } from "./values/evaluator.js";

const FILE = "myapp/routes/todos.py";

/**
 * The decorator, with the facts a project run hands discovery, since the
 * rules are what say a name holding a constructed router came from the
 * library that constructed it.
 */
async function firstDecorator(source: string) {
  const tree = await parsePython(source);
  const module = bindModule(tree.rootNode);
  const db = new Database();
  emitModuleImportFacts(db, FILE, module, { roots: [] });
  emitValueFacts(db, FILE, tree.rootNode);
  bindEvaluator(db, {
    files: [{ file: FILE, root: tree.rootNode, module }],
    definitions: new Map(),
  });
  const stmt = tree.rootNode.namedChildren.find(
    (c) => c !== null && c.type === "decorated_definition",
  );
  if (stmt === null || stmt === undefined) {
    throw new Error(
      "expected a decorated_definition among the module's statements",
    );
  }
  const decorator = stmt.namedChildren.find(
    (c) => c !== null && c.type === "decorator",
  );
  if (decorator === null || decorator === undefined) {
    throw new Error("expected a decorator");
  }
  return { decorator, module, db };
}

describe("classifyDecorator: direct import", () => {
  it("classifies a bare decorator imported directly", async () => {
    const { decorator, module, db } = await firstDecorator(
      "from myapp.wrappers.restx import route\n\n\n@route\ndef f():\n    pass\n",
    );
    const result = classifyDecorator(decorator, module, db);
    expect(result.module).toBe("myapp.wrappers.restx");
    expect(result.importedName).toBe("route");
    expect(result.args).toEqual([]);
  });

  it("classifies a call decorator and reads its positional string argument", async () => {
    const { decorator, module, db } = await firstDecorator(
      'from myapp.wrappers.restx import route\n\n\n@route("/todos")\ndef f():\n    pass\n',
    );
    const result = classifyDecorator(decorator, module, db);
    expect(result.module).toBe("myapp.wrappers.restx");
    expect(result.importedName).toBe("route");
    expect(result.args).toMatchObject([{ kind: "string", value: "/todos" }]);
  });

  it("classifies through an aliased import, resolving to the original name", async () => {
    const { decorator, module, db } = await firstDecorator(
      'from myapp.wrappers.restx import route as api_route\n\n\n@api_route("/orders")\ndef f():\n    pass\n',
    );
    const result = classifyDecorator(decorator, module, db);
    expect(result.module).toBe("myapp.wrappers.restx");
    expect(result.importedName).toBe("route");
  });

  it("reads keyword arguments, including a list value", async () => {
    const { decorator, module, db } = await firstDecorator(
      'from flask_restx import route\n\n\n@route("/todos", methods=["GET", "POST"])\ndef f():\n    pass\n',
    );
    const result = classifyDecorator(decorator, module, db);
    expect(result.keywordArgs.methods).toMatchObject({
      kind: "list",
      items: [
        { kind: "string", value: "GET" },
        { kind: "string", value: "POST" },
      ],
    });
  });

  it("reads a number and an identifier keyword argument", async () => {
    const { decorator, module, db } = await firstDecorator(
      'from myapp.wrappers.restx import route\n\n\n@route("/items", status_code=201, response_model=TodoResponse)\ndef f():\n    pass\n',
    );
    const result = classifyDecorator(decorator, module, db);
    expect(result.keywordArgs.status_code).toMatchObject({
      kind: "number",
      value: 201,
    });
    expect(result.keywordArgs.response_model).toMatchObject({
      kind: "identifier",
      name: "TodoResponse",
    });
  });
});

describe("classifyDecorator: attribute access", () => {
  it("classifies an attribute decorator through a plain module import", async () => {
    const { decorator, module, db } = await firstDecorator(
      'import myapp.wrappers.restx as api\n\n\n@api.route("/todos")\ndef f():\n    pass\n',
    );
    const result = classifyDecorator(decorator, module, db);
    expect(result.module).toBe("myapp.wrappers.restx");
    expect(result.importedName).toBe("route");
  });

  it("classifies an attribute decorator through a one-hop constructor assignment", async () => {
    const { decorator, module, db } = await firstDecorator(
      'from fastapi import FastAPI\napp = FastAPI()\n\n\n@app.get("/items/{item_id}")\ndef f():\n    pass\n',
    );
    const result = classifyDecorator(decorator, module, db);
    expect(result.module).toBe("fastapi");
    expect(result.importedName).toBe("get");
  });

  it("names the dotted module an imported name's attribute comes from", async () => {
    const { decorator, module, db } = await firstDecorator(
      "from myapp.wrappers import restx\n\n\n@restx.route\ndef f():\n    pass\n",
    );
    const result = classifyDecorator(decorator, module, db);
    expect(result.module).toBe("myapp.wrappers.restx");
    expect(result.importedName).toBe("route");
  });
});

describe("classifyDecorator: unresolved", () => {
  it("leaves a project-local decorator unresolved", async () => {
    const { decorator, module, db } = await firstDecorator(
      "def route(f):\n    return f\n\n\n@route\ndef g():\n    pass\n",
    );
    const result = classifyDecorator(decorator, module, db);
    expect(result.module).toBeNull();
    expect(result.importedName).toBeNull();
  });

  it("leaves an unresolved base object's attribute decorator unresolved", async () => {
    const { decorator, module, db } = await firstDecorator(
      "@something.route\ndef f():\n    pass\n",
    );
    const result = classifyDecorator(decorator, module, db);
    expect(result.module).toBeNull();
  });

  it("leaves a decorator built by a call on a call unresolved", async () => {
    const { decorator, module, db } = await firstDecorator(
      'from fastapi import FastAPI\n\n\n@FastAPI()("/x")\ndef f():\n    pass\n',
    );
    const result = classifyDecorator(decorator, module, db);
    expect(result.module).toBeNull();
  });

  it("leaves a constructed object unresolved when the run has no facts", async () => {
    const { decorator, module } = await firstDecorator(
      'from fastapi import FastAPI\napp = FastAPI()\n\n\n@app.get("/x")\ndef f():\n    pass\n',
    );
    const result = classifyDecorator(decorator, module);
    expect(result.module).toBeNull();
  });
});

describe("classifyDecorator: an object built through a module", () => {
  it("resolves a decorator on a router the imported module constructed", async () => {
    const { decorator, module, db } = await firstDecorator(
      [
        "import fastapi",
        "",
        'router = fastapi.APIRouter(prefix="/items")',
        "",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
      ].join("\n"),
    );
    const result = classifyDecorator(decorator, module, db);
    expect(result.module).toBe("fastapi");
    expect(result.importedName).toBe("get");
    expect(result.objectName).toBe("router");
  });

  it("puts an object built by a call nothing imports down to a builtin, which no pack accepts", async () => {
    const { decorator, module, db } = await firstDecorator(
      [
        "router = make_router()",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
      ].join("\n"),
    );
    expect(classifyDecorator(decorator, module, db).module).toBe("builtins");
  });

  it("names the submodule a two-hop constructor comes from", async () => {
    const { decorator, module, db } = await firstDecorator(
      [
        "import fastapi",
        "",
        "router = fastapi.routing.APIRouter()",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
      ].join("\n"),
    );
    expect(classifyDecorator(decorator, module, db).module).toBe(
      "fastapi.routing",
    );
  });
});

describe("classifyDecorator: a name assigned more than one construction", () => {
  it("names the module both constructions came from, and no construction", async () => {
    const { decorator, module, db } = await firstDecorator(
      [
        "from fastapi import APIRouter",
        "",
        'router = APIRouter(prefix="/first")',
        "",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
        "",
        'router = APIRouter(prefix="/second")',
        "",
      ].join("\n"),
    );
    const result = classifyDecorator(decorator, module, db);
    expect(result.module).toBe("fastapi");
    expect(result.importedName).toBe("get");
    expect(result.objectName).toBe("router");
    expect(result.subjectConstruction).toBeUndefined();
  });

  it("leaves a name built out of two different modules unresolved", async () => {
    const { decorator, module, db } = await firstDecorator(
      [
        "from fastapi import APIRouter",
        "from flask_restx import Namespace",
        "",
        'router = APIRouter(prefix="/first")',
        "",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
        "",
        'router = Namespace("orders")',
        "",
      ].join("\n"),
    );
    expect(classifyDecorator(decorator, module, db).module).toBeNull();
  });
});
