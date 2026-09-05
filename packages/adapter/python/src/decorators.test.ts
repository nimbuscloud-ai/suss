import { describe, expect, it } from "vitest";

import { classifyDecorator } from "./decorators.js";
import { parsePython } from "./parser.js";
import { bindModule } from "./scope.js";

async function firstDecorator(source: string) {
  const tree = await parsePython(source);
  const binding = bindModule(tree.rootNode);
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
  return { decorator, scope: binding.moduleScope };
}

describe("classifyDecorator: direct import", () => {
  it("classifies a bare decorator imported directly", async () => {
    const { decorator, scope } = await firstDecorator(
      "from myapp.wrappers.restx import route\n\n\n@route\ndef f():\n    pass\n",
    );
    const result = classifyDecorator(decorator, scope);
    expect(result.module).toBe("myapp.wrappers.restx");
    expect(result.importedName).toBe("route");
    expect(result.args).toEqual([]);
  });

  it("classifies a call decorator and reads its positional string argument", async () => {
    const { decorator, scope } = await firstDecorator(
      'from myapp.wrappers.restx import route\n\n\n@route("/todos")\ndef f():\n    pass\n',
    );
    const result = classifyDecorator(decorator, scope);
    expect(result.module).toBe("myapp.wrappers.restx");
    expect(result.importedName).toBe("route");
    expect(result.args).toMatchObject([{ kind: "string", value: "/todos" }]);
  });

  it("classifies through an aliased import, resolving to the original name", async () => {
    const { decorator, scope } = await firstDecorator(
      'from myapp.wrappers.restx import route as api_route\n\n\n@api_route("/orders")\ndef f():\n    pass\n',
    );
    const result = classifyDecorator(decorator, scope);
    expect(result.module).toBe("myapp.wrappers.restx");
    expect(result.importedName).toBe("route");
  });

  it("reads keyword arguments, including a list value", async () => {
    const { decorator, scope } = await firstDecorator(
      'from flask_restx import route\n\n\n@route("/todos", methods=["GET", "POST"])\ndef f():\n    pass\n',
    );
    const result = classifyDecorator(decorator, scope);
    expect(result.keywordArgs.methods).toMatchObject({
      kind: "list",
      items: [
        { kind: "string", value: "GET" },
        { kind: "string", value: "POST" },
      ],
    });
  });

  it("reads a number and an identifier keyword argument", async () => {
    const { decorator, scope } = await firstDecorator(
      'from myapp.wrappers.restx import route\n\n\n@route("/items", status_code=201, response_model=TodoResponse)\ndef f():\n    pass\n',
    );
    const result = classifyDecorator(decorator, scope);
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
    const { decorator, scope } = await firstDecorator(
      'import myapp.wrappers.restx as api\n\n\n@api.route("/todos")\ndef f():\n    pass\n',
    );
    const result = classifyDecorator(decorator, scope);
    expect(result.module).toBe("myapp.wrappers.restx");
    expect(result.importedName).toBe("route");
  });

  it("classifies an attribute decorator through a one-hop constructor assignment", async () => {
    const { decorator, scope } = await firstDecorator(
      'from fastapi import FastAPI\napp = FastAPI()\n\n\n@app.get("/items/{item_id}")\ndef f():\n    pass\n',
    );
    const result = classifyDecorator(decorator, scope);
    expect(result.module).toBe("fastapi");
    expect(result.importedName).toBe("get");
  });
});

describe("classifyDecorator: unresolved", () => {
  it("leaves a project-local decorator unresolved", async () => {
    const { decorator, scope } = await firstDecorator(
      "def route(f):\n    return f\n\n\n@route\ndef g():\n    pass\n",
    );
    const result = classifyDecorator(decorator, scope);
    expect(result.module).toBeNull();
    expect(result.importedName).toBeNull();
  });

  it("leaves a two-hop attribute chain unresolved rather than guessing", async () => {
    const { decorator, scope } = await firstDecorator(
      "from myapp.wrappers import restx\n\n\n@restx.route\ndef f():\n    pass\n",
    );
    const result = classifyDecorator(decorator, scope);
    expect(result.module).toBeNull();
  });

  it("leaves an unresolved base object's attribute decorator unresolved", async () => {
    const { decorator, scope } = await firstDecorator(
      "@something.route\ndef f():\n    pass\n",
    );
    const result = classifyDecorator(decorator, scope);
    expect(result.module).toBeNull();
  });
});

describe("classifyDecorator: an object built through a module", () => {
  it("resolves a decorator on a router the imported module constructed", async () => {
    const { decorator, scope } = await firstDecorator(
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
    const result = classifyDecorator(decorator, scope);
    expect(result.module).toBe("fastapi");
    expect(result.importedName).toBe("get");
    expect(result.objectName).toBe("router");
  });

  it("leaves a decorator on an object built by a call nobody can follow unresolved", async () => {
    const { decorator, scope } = await firstDecorator(
      [
        "router = make_router()",
        "",
        '@router.get("/ping")',
        "def ping():",
        "    pass",
        "",
      ].join("\n"),
    );
    expect(classifyDecorator(decorator, scope).module).toBeNull();
  });

  it("leaves a decorator on an object built through two hops unresolved", async () => {
    const { decorator, scope } = await firstDecorator(
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
    expect(classifyDecorator(decorator, scope).module).toBeNull();
  });
});
