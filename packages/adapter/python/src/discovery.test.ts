import { describe, expect, it } from "vitest";

import { assembleSummary } from "@suss/extractor";

import { discoverUnits } from "./discovery.js";
import { parsePython } from "./parser.js";
import { bindModule } from "./scope.js";

import type { RawCodeStructure } from "@suss/extractor";
import type { PythonPack } from "./pack.js";

/** Every gap description on a unit's summary, joined into one string to match against. */
function unreadTextOf(unit: RawCodeStructure | undefined): string {
  return unit === undefined
    ? ""
    : assembleSummary(unit)
        .gaps.map((gap) => gap.description)
        .join("\n");
}

/** The status a unit's summary claims for its first declared response. */
function claimedStatusOf(unit: RawCodeStructure | undefined) {
  if (unit === undefined) {
    return undefined;
  }

  const output = assembleSummary(unit).transitions[0]?.output;
  return output?.type === "response" ? output.statusCode : undefined;
}

/** The body shape a unit's summary claims for its first declared response. */
function claimedBodyOf(unit: RawCodeStructure | undefined) {
  if (unit === undefined) {
    return undefined;
  }

  const output = assembleSummary(unit).transitions[0]?.output;
  return output?.type === "response" ? output.body : undefined;
}

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
      pathParamSyntax: "flaskConverters",
      defaultStatusCode: 200,
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
      pathParamSyntax: "braces",
      annotatedClassIsRequestBody: true,
      defaultStatusCode: 200,
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

  it("takes the pack's declared default for a method whose return annotation states a shape", async () => {
    const annotated = [
      "from myapp.wrappers.restx import route",
      "",
      "",
      "class TodoResponse:",
      "    id: int",
      "",
      "",
      '@route("/todos")',
      "class TodoList:",
      "    def get(self) -> TodoResponse:",
      "        return TodoResponse()",
      "",
    ].join("\n");
    const units = await unitsOf(annotated, [flaskRestxLike]);
    const get = units.find((u) => u.identity.name === "TodoList.get");
    expect(claimedStatusOf(get)).toEqual({ type: "literal", value: 200 });
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

  it("classifies a converter-typed path parameter and claims the path in canonical brace form", async () => {
    const orderSource = [
      "from myapp.wrappers.restx import route as api_route",
      "",
      "",
      '@api_route("/orders/<int:order_id>")',
      "class OrderDetail:",
      "    def get(self, order_id):",
      "        return {}",
      "",
    ].join("\n");
    const units = await unitsOf(orderSource, [flaskRestxLike]);
    const get = units.find((u) => u.identity.name === "OrderDetail.get");
    expect(get?.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/orders/{order_id}",
    });
    expect(get?.parameters).toEqual([
      { name: "order_id", position: 1, role: "pathParams", typeText: null },
    ]);
  });

  it("reads Werkzeug's converter-argument forms, lazily to the first closing parenthesis", async () => {
    const argsSource = [
      "from myapp.wrappers.restx import route",
      "",
      "",
      '@route("/orders/<int(min=0):order_id>/<any(home,about):page>")',
      "class OrderPage:",
      "    def get(self, order_id, page):",
      "        return {}",
      "",
    ].join("\n");
    const units = await unitsOf(argsSource, [flaskRestxLike]);
    const get = units.find((u) => u.identity.name === "OrderPage.get");
    expect(get?.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/orders/{order_id}/{page}",
    });
    expect(get?.parameters).toEqual([
      { name: "order_id", position: 1, role: "pathParams", typeText: null },
      { name: "page", position: 2, role: "pathParams", typeText: null },
    ]);
  });

  it("leaves an annotated-class parameter a query parameter when the pattern declares no body convention", async () => {
    const annotatedSource = [
      "from myapp.wrappers.restx import route",
      "",
      "",
      "class TodoPayload:",
      "    title: str",
      "",
      "",
      '@route("/todos")',
      "class TodoList:",
      "    def post(self, payload: TodoPayload):",
      "        return {}, 201",
      "",
    ].join("\n");
    const units = await unitsOf(annotatedSource, [flaskRestxLike]);
    const post = units.find((u) => u.identity.name === "TodoList.post");
    expect(post?.parameters).toEqual([
      {
        name: "payload",
        position: 1,
        role: "queryParams",
        typeText: "TodoPayload",
      },
    ]);
  });

  it("reads a bare converter-less template parameter the same way", async () => {
    const userSource = [
      "from myapp.wrappers.restx import route",
      "",
      "",
      '@route("/users/<name>")',
      "class UserDetail:",
      "    def get(self, name):",
      "        return {}",
      "",
    ].join("\n");
    const units = await unitsOf(userSource, [flaskRestxLike]);
    const get = units.find((u) => u.identity.name === "UserDetail.get");
    expect(get?.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/users/{name}",
    });
    expect(get?.parameters).toEqual([
      { name: "name", position: 1, role: "pathParams", typeText: null },
    ]);
  });

  it("keeps a route whose pack declares an unknown template syntax discovered, pathless, with a stated gap", async () => {
    const unknownSyntaxPack: PythonPack = {
      name: "flask-restx",
      protocol: "http",
      discovery: [
        {
          type: "decoratedClassRoute",
          importModule: ["myapp.wrappers.restx"],
          decoratorName: "route",
          verbMethodNames: { get: "GET" },
          pathParamSyntax: "notASyntaxThisAdapterReads",
        },
      ],
    };
    const units = await unitsOf(source, [unknownSyntaxPack]);
    const get = units.find((u) => u.identity.name === "TodoList.get");
    expect(get).toBeDefined();
    expect(get?.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: null,
    });
    expect(unreadTextOf(get)).toContain("notASyntaxThisAdapterReads");
  });

  it("reads a path as written, with no path parameters, when the pack declares no template syntax", async () => {
    const noSyntaxPack: PythonPack = {
      name: "flask-restx",
      protocol: "http",
      discovery: [
        {
          type: "decoratedClassRoute",
          importModule: ["myapp.wrappers.restx"],
          decoratorName: "route",
          verbMethodNames: { get: "GET" },
        },
      ],
    };
    const orderSource = [
      "from myapp.wrappers.restx import route",
      "",
      "",
      '@route("/orders/<int:order_id>")',
      "class OrderDetail:",
      "    def get(self, order_id):",
      "        return {}",
      "",
    ].join("\n");
    const units = await unitsOf(orderSource, [noSyntaxPack]);
    const get = units.find((u) => u.identity.name === "OrderDetail.get");
    expect(get?.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/orders/<int:order_id>",
    });
    expect(get?.parameters).toEqual([
      { name: "order_id", position: 1, role: "queryParams", typeText: null },
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

  it("reads Starlette's typed converters and drops the converter from the canonical path", async () => {
    const typedSource = [
      "from fastapi import FastAPI",
      "",
      "app = FastAPI()",
      "",
      "",
      '@app.get("/files/{item_id:int}/{file_path:path}")',
      "def read_file(item_id: int, file_path: str):",
      "    pass",
      "",
    ].join("\n");
    const units = await unitsOf(typedSource, [fastapiLike]);
    const readFile = units.find((u) => u.identity.name === "read_file");
    expect(readFile?.boundaryBinding?.semantics).toEqual({
      name: "rest",
      method: "GET",
      path: "/files/{item_id}/{file_path}",
    });
    expect(readFile?.parameters).toEqual([
      { name: "item_id", position: 0, role: "pathParams", typeText: "int" },
      { name: "file_path", position: 1, role: "pathParams", typeText: "str" },
    ]);
  });

  it("reads response_model into a single declared-shape transition, with status_code when given", async () => {
    const units = await unitsOf(source, [fastapiLike]);
    const createItem = units.find((u) => u.identity.name === "create_item");
    expect(createItem?.branches).toHaveLength(1);
    const branch = createItem?.branches[0];
    expect(claimedStatusOf(createItem)).toEqual({
      type: "literal",
      value: 201,
    });
    expect(claimedBodyOf(createItem)?.type).toBe("ref");
    expect(branch?.isDefault).toBe(true);
    expect(branch?.conditions).toEqual([]);
  });

  it("claims no status when the decorator writes one the reader cannot read", async () => {
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
    expect(claimedStatusOf(createItem)).toBeNull();
    expect(claimedBodyOf(createItem)?.type).toBe("ref");
    expect(unreadTextOf(createItem)).toContain("not a literal number");
  });

  it("takes the status its pack declares as the library's default when the route states none", async () => {
    const units = await unitsOf(source, [fastapiLike]);
    const readItem = units.find((u) => u.identity.name === "read_item");
    expect(claimedStatusOf(readItem)).toEqual({
      type: "literal",
      value: 200,
    });
  });

  it("claims no status when the route states none and its pack declares no default", async () => {
    const noDefault: PythonPack = {
      name: "fastapi-test",
      protocol: "http",
      discovery: [
        {
          type: "decoratedFunctionRoute",
          importModule: ["fastapi"],
          verbAttributeNames: { get: "GET", post: "POST" },
          pathParamSyntax: "braces",
          annotatedClassIsRequestBody: true,
          responseModelKeyword: "response_model",
          statusCodeKeyword: "status_code",
        },
      ],
    };
    const units = await unitsOf(source, [noDefault]);
    const readItem = units.find((u) => u.identity.name === "read_item");
    expect(claimedStatusOf(readItem)).toBeNull();
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
    expect(claimedBodyOf(listItems)?.type).toBe("ref");
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
    expect(unreadTextOf(report)).toContain("not a string literal");
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

  it("discovers nothing when a configured decorator sits on the definition shape its pattern does not read", async () => {
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

describe("a route the readers cannot turn into a unit (an empty path, which the binding builder refuses)", () => {
  const source = [
    "from myapp.wrappers.restx import route",
    "",
    "",
    '@route("")',
    "class Root:",
    "    def get(self):",
    "        return []",
    "",
    "",
    '@route("/todos")',
    "class TodoList:",
    "    def get(self):",
    "        return []",
    "",
  ].join("\n");

  it("keeps the route, names no path, and says what stopped it", async () => {
    const units = await unitsOf(source, [flaskRestxLike]);
    const root = units.find((u) => u.identity.name === "Root.get");
    const semantics = root?.boundaryBinding?.semantics;
    expect(semantics?.name === "rest" ? semantics.path : "kept").toBeNull();
    expect(semantics?.name === "rest" ? semantics.method : null).toBe("GET");
    expect(unreadTextOf(root)).toContain("could not be read into a unit");
  });

  it("lets every other route in the file through", async () => {
    const units = await unitsOf(source, [flaskRestxLike]);
    expect(units.map((u) => u.identity.name)).toEqual([
      "Root.get",
      "TodoList.get",
    ]);
    const todos = units.find((u) => u.identity.name === "TodoList.get");
    const semantics = todos?.boundaryBinding?.semantics;
    expect(semantics?.name === "rest" ? semantics.path : null).toBe("/todos");
  });

  it("lets the error stand when the caller asked for strict gap handling", async () => {
    const tree = await parsePython(source);
    const binding = bindModule(tree.rootNode);
    expect(() =>
      discoverUnits(tree.rootNode, binding, {
        packs: [flaskRestxLike],
        filePath: "myapp/routes/todos.py",
        gapHandling: "strict",
      }),
    ).toThrow("empty string");
  });
});
