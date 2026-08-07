import { describe, expect, it } from "vitest";

import { discoverUnits } from "./discovery.js";
import { parsePython } from "./parser.js";
import { bindModule } from "./scope.js";

import type { PythonPack } from "./pack.js";

const flaskRestxLike: PythonPack = {
  name: "flask-restx",
  protocol: "http",
  discovery: [
    {
      type: "decoratedClassRoute",
      importModule: ["myapp.wrappers.restx"],
      decoratorName: "route",
      verbMethodNames: {
        get: "GET",
        post: "POST",
        put: "PUT",
        delete: "DELETE",
      },
    },
  ],
};

const fastapiLike: PythonPack = {
  name: "fastapi-test",
  protocol: "http",
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      verbAttributeNames: { get: "GET", post: "POST" },
      responseModelKeyword: "response_model",
      statusCodeKeyword: "status_code",
    },
  ],
};

async function unitsOf(source: string, packs: PythonPack[]) {
  const tree = await parsePython(source);
  const binding = bindModule(tree.rootNode);
  return discoverUnits(tree.rootNode, binding, {
    packs,
    filePath: "myapp/routes/todos.py",
  });
}

describe("discoverUnits: decoratedClassRoute (flask-restx style)", () => {
  const source = [
    "from myapp.wrappers.restx import route",
    "",
    "",
    '@route("/todos")',
    "class TodoList:",
    "    def get(self):",
    "        return []",
    "",
    "    def post(self):",
    "        return {}, 201",
    "",
    "    def helper(self):",
    "        return None",
    "",
  ].join("\n");

  it("discovers one unit per HTTP-verb-named method, skipping other methods", async () => {
    const units = await unitsOf(source, [flaskRestxLike]);
    expect(units.map((u) => u.identity.name).sort()).toEqual([
      "TodoList.get",
      "TodoList.post",
    ]);
  });

  it("builds a rest boundary binding with the class decorator's path and the method's verb", async () => {
    const units = await unitsOf(source, [flaskRestxLike]);
    const get = units.find((u) => u.identity.name === "TodoList.get");
    expect(get?.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/todos" },
      recognition: "flask-restx",
    });
  });

  it("skips the self parameter and reports an empty parameter list otherwise", async () => {
    const units = await unitsOf(source, [flaskRestxLike]);
    const get = units.find((u) => u.identity.name === "TodoList.get");
    expect(get?.parameters).toEqual([]);
  });

  it("leaves transitions empty when nothing declares a response shape", async () => {
    const units = await unitsOf(source, [flaskRestxLike]);
    const get = units.find((u) => u.identity.name === "TodoList.get");
    expect(get?.branches).toEqual([]);
    expect(get?.bodyContent).toBe("statements");
  });

  it("classifies a path parameter by name against the route's path template", async () => {
    const orderSource = [
      "from myapp.wrappers.restx import route as api_route",
      "",
      "",
      '@api_route("/orders/{order_id}")',
      "class OrderDetail:",
      "    def get(self, order_id):",
      "        return {}",
      "",
    ].join("\n");
    const units = await unitsOf(orderSource, [flaskRestxLike]);
    const get = units.find((u) => u.identity.name === "OrderDetail.get");
    expect(get?.parameters).toEqual([
      { name: "order_id", position: 1, role: "pathParams", typeText: null },
    ]);
  });

  it("discovers nothing when the decorator doesn't resolve to a configured module", async () => {
    const unconfigured = [
      "from someone_elses_wrapper import route",
      "",
      "",
      '@route("/todos")',
      "class TodoList:",
      "    def get(self):",
      "        return []",
      "",
    ].join("\n");
    const units = await unitsOf(unconfigured, [flaskRestxLike]);
    expect(units).toEqual([]);
  });

  it("discovers nothing without a resolvable string path argument", async () => {
    const noPath = [
      "from myapp.wrappers.restx import route",
      "",
      "",
      "@route",
      "class TodoList:",
      "    def get(self):",
      "        return []",
      "",
    ].join("\n");
    const units = await unitsOf(noPath, [flaskRestxLike]);
    expect(units).toEqual([]);
  });
});

describe("discoverUnits: decoratedFunctionRoute (FastAPI style)", () => {
  const source = [
    "from typing import Optional",
    "from fastapi import FastAPI",
    "",
    "app = FastAPI()",
    "",
    "",
    "class TodoResponse:",
    "    id: int",
    "    title: str",
    "",
    "",
    '@app.get("/items/{item_id}", response_model=TodoResponse)',
    "def read_item(item_id: int, q: Optional[str] = None):",
    "    pass",
    "",
    "",
    '@app.post("/items", status_code=201, response_model=TodoResponse)',
    "def create_item(payload: TodoResponse):",
    "    pass",
    "",
  ].join("\n");

  it("discovers one unit per decorated function", async () => {
    const units = await unitsOf(source, [fastapiLike]);
    expect(units.map((u) => u.identity.name).sort()).toEqual([
      "create_item",
      "read_item",
    ]);
  });

  it("builds a rest binding whose verb comes from the decorator's own attribute name", async () => {
    const units = await unitsOf(source, [fastapiLike]);
    const readItem = units.find((u) => u.identity.name === "read_item");
    expect(readItem?.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/items/{item_id}" },
      recognition: "fastapi-test",
    });
  });

  it("classifies a path parameter by name and a Pydantic-shaped parameter as a request body", async () => {
    const units = await unitsOf(source, [fastapiLike]);
    const readItem = units.find((u) => u.identity.name === "read_item");
    expect(readItem?.parameters).toEqual([
      { name: "item_id", position: 0, role: "pathParams", typeText: "int" },
      {
        name: "q",
        position: 1,
        role: "queryParams",
        typeText: "Optional[str]",
      },
    ]);

    const createItem = units.find((u) => u.identity.name === "create_item");
    expect(createItem?.parameters).toEqual([
      {
        name: "payload",
        position: 0,
        role: "requestBody",
        typeText: "TodoResponse",
      },
    ]);
  });

  it("reads response_model into a single declared-shape transition, with status_code when given", async () => {
    const units = await unitsOf(source, [fastapiLike]);
    const createItem = units.find((u) => u.identity.name === "create_item");
    expect(createItem?.branches).toHaveLength(1);
    const branch = createItem?.branches[0];
    expect(branch?.terminal.statusCode).toEqual({
      type: "literal",
      value: 201,
    });
    expect(branch?.terminal.body?.shape?.type).toBe("ref");
    expect(branch?.isDefault).toBe(true);
    expect(branch?.conditions).toEqual([]);
  });

  it("claims no status when the decorator writes one the reader cannot read", async () => {
    // status_code=CODE runs at whatever CODE holds. Found by the
    // Python differential fuzzer: defaulting to 200 here promised a
    // status the running app contradicted.
    const computedStatus = [
      "from fastapi import FastAPI",
      "",
      "app = FastAPI()",
      "",
      "CODE = 201",
      "",
      "",
      "class TodoResponse:",
      "    id: int",
      "",
      "",
      '@app.post("/items", status_code=CODE)',
      "def create_item() -> TodoResponse:",
      "    pass",
      "",
    ].join("\n");
    const units = await unitsOf(computedStatus, [fastapiLike]);
    const createItem = units.find((u) => u.identity.name === "create_item");
    expect(createItem?.branches).toHaveLength(1);
    expect(createItem?.branches[0]?.terminal.statusCode).toBeNull();
    expect(createItem?.branches[0]?.terminal.body?.shape?.type).toBe("ref");
  });

  it("defaults an unstated status to 200 once a response shape is known", async () => {
    const units = await unitsOf(source, [fastapiLike]);
    const readItem = units.find((u) => u.identity.name === "read_item");
    expect(readItem?.branches[0]?.terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
  });

  it("falls back to the return annotation when there is no response_model keyword", async () => {
    const returnOnly = [
      "from fastapi import FastAPI",
      "",
      "app = FastAPI()",
      "",
      "",
      "class TodoResponse:",
      "    id: int",
      "",
      "",
      '@app.get("/items")',
      "def list_items() -> TodoResponse:",
      "    pass",
      "",
    ].join("\n");
    const units = await unitsOf(returnOnly, [fastapiLike]);
    const listItems = units.find((u) => u.identity.name === "list_items");
    expect(listItems?.branches).toHaveLength(1);
    expect(listItems?.branches[0]?.terminal.body?.shape?.type).toBe("ref");
  });

  it("keeps a route whose path is not a literal, with no path and a stated gap", async () => {
    const dynamicPath = [
      "from fastapi import FastAPI",
      "",
      "app = FastAPI()",
      "",
      'SECTION = "summary"',
      "",
      "",
      '@app.get("/reports/" + SECTION)',
      "def report():",
      "    pass",
      "",
    ].join("\n");
    const units = await unitsOf(dynamicPath, [fastapiLike]);
    const report = units.find((u) => u.identity.name === "report");
    expect(report).toBeDefined();
    expect(report?.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: null,
    });
    expect(report?.unreadBinding).toContain("not a string literal");
  });

  it("carries the response model's record shape in definitions", async () => {
    const units = await unitsOf(source, [fastapiLike]);
    const createItem = units.find((u) => u.identity.name === "create_item");
    expect(createItem?.definitions).toBeDefined();
    const values = Object.values(createItem?.definitions ?? {});
    expect(values).toContainEqual({
      type: "record",
      properties: { id: { type: "integer" }, title: { type: "text" } },
    });
  });

  it("matches each pattern only against its own definition shape", async () => {
    // The class-route decorator sitting on a function, and the
    // verb-attribute decorator sitting on a class: both resolve to a
    // configured module, and neither shape is the one its pattern
    // reads, so neither may produce a unit.
    const mixed = [
      "from myapp.wrappers.restx import route",
      "from fastapi import FastAPI",
      "",
      "app = FastAPI()",
      "",
      "",
      '@route("/todos")',
      "class TodoList:",
      "    def get(self):",
      "        return []",
      "",
      "",
      '@route("/helpers")',
      "def helper():",
      "    pass",
      "",
      "",
      '@app.get("/items")',
      "def list_items():",
      "    pass",
      "",
      "",
      '@app.get("/legacy")',
      "class Legacy:",
      "    def get(self):",
      "        return []",
      "",
    ].join("\n");
    const units = await unitsOf(mixed, [flaskRestxLike, fastapiLike]);
    expect(
      units.map((u) => [u.identity.name, u.boundaryBinding?.recognition]),
    ).toEqual([
      ["TodoList.get", "flask-restx"],
      ["list_items", "fastapi-test"],
    ]);
  });
});
