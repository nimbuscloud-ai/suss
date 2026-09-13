import { describe, expect, it } from "vitest";

import { clientCallUnits } from "./clientCalls.js";
import { parsePython } from "./parser.js";
import { factsForFile } from "./project.js";
import { bindModule } from "./scope.js";

import type { RawCodeStructure } from "@suss/extractor";
import type { PyClientCall, PythonPack } from "./pack.js";

/** A library like requests, written the way a pack writes one. */
const REQUEST_CALLS: PyClientCall = {
  type: "clientCall",
  importModule: ["httpclient"],
  verbAttributeNames: { get: "GET", post: "POST" },
  url: { position: 0, keyword: "url" },
  methodCall: {
    attribute: "send",
    methodPosition: 0,
    methodKeyword: "method",
    urlPosition: 1,
  },
  receiverConstructors: ["Session"],
};

const PACK: PythonPack = {
  name: "httpclient",
  protocol: "http",
  discovery: [],
  clients: [REQUEST_CALLS],
  contextManagers: [{ module: "httpclient", returnsSelf: ["Session"] }],
};

const FILE = "app/orders.py";

/**
 * The units, with the facts a project run hands discovery, since the
 * rules are what say a receiver was built by the library's constructor.
 */
async function unitsIn(
  source: string,
  pattern: PyClientCall = REQUEST_CALLS,
): Promise<RawCodeStructure[]> {
  const tree = await parsePython(source);
  const root = tree.rootNode;
  const module = bindModule(root);
  const facts = factsForFile({ file: FILE, root, module, packs: [PACK] });
  return clientCallUnits(root, module, PACK, pattern, {
    filePath: FILE,
    facts,
  });
}

/** The method and path of the first unit, for the common case. */
function boundary(units: RawCodeStructure[]): {
  method: string | null;
  path: string | null;
} {
  const semantics = units[0]?.boundaryBinding?.semantics;
  if (semantics?.name !== "rest") {
    throw new Error(
      `expected a REST boundary, got ${JSON.stringify(semantics)}`,
    );
  }
  return { method: semantics.method, path: semantics.path };
}

describe("a function that calls a request function", () => {
  it("is a client of the boundary the call states", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "def load():",
        '    return httpclient.get("/orders")',
      ].join("\n"),
    );

    expect(units).toHaveLength(1);
    expect(units[0]?.identity.kind).toBe("client");
    expect(units[0]?.identity.exportPath).toEqual(["load"]);
    expect(boundary(units)).toEqual({ method: "GET", path: "/orders" });
  });

  it("reads the URL written under the keyword", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "def load():",
        '    return httpclient.get(url="/orders", timeout=5)',
      ].join("\n"),
    );

    expect(boundary(units).path).toBe("/orders");
  });

  it("reads the method written under its own keyword", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "def load():",
        '    return httpclient.send(method="PUT", url="/orders")',
      ].join("\n"),
    );

    expect(boundary(units)).toEqual({ method: "PUT", path: "/orders" });
  });

  it("is a client of both boundaries when it calls twice", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "def sync():",
        '    httpclient.get("/orders")',
        '    return httpclient.post("/audit")',
      ].join("\n"),
    );

    expect(
      units.map((unit) => {
        const semantics = unit.boundaryBinding?.semantics;
        return semantics?.name === "rest"
          ? `${semantics.method} ${semantics.path}`
          : "";
      }),
    ).toEqual(["GET /orders", "POST /audit"]);
  });

  it("says nothing about a method argument that is not a literal", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "def load(verb):",
        '    return httpclient.send(verb, "/orders")',
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("says nothing about a call with no arguments at all", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "def load():",
        "    return httpclient.get()",
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("says nothing about a receiver the library did not build", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "client = object()",
        "",
        "def load():",
        '    return client.get("/orders")',
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("says nothing about a receiver bound to something that is not a call", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "client = SESSIONS[0]",
        "",
        "def load():",
        '    return client.get("/orders")',
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("says nothing about a call the pack declares no method for", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "def load():",
        '    return httpclient.stream("/orders")',
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("says nothing about a call whose callee is itself a call", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "def load():",
        '    return getattr(httpclient, "get")("/orders")',
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("reads a session call on a receiver a with block opened", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "def load():",
        "    with httpclient.Session() as session:",
        '        return session.get("/orders")',
      ].join("\n"),
    );

    expect(boundary(units)).toEqual({ method: "GET", path: "/orders" });
  });

  it("says nothing about a with block over a constructor no pack declared", async () => {
    const units = await unitsIn(
      [
        "import contextlib",
        "",
        "def load():",
        "    with contextlib.nullcontext() as session:",
        '        return session.get("/orders")',
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("reads a session call written inside a nested function", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "session = httpclient.Session()",
        "",
        "def outer():",
        "    def inner():",
        '        return session.get("/orders")',
        "    return inner",
      ].join("\n"),
    );

    expect(units.map((unit) => unit.identity.name)).toEqual(["inner"]);
  });

  it("says which members of the response mean what, when the pack said", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "def load():",
        '    return httpclient.get("/orders")',
      ].join("\n"),
      {
        ...REQUEST_CALLS,
        response: {
          statusCode: ["status_code"],
          success: ["ok"],
          body: ["json"],
          failureDelivery: "response",
        },
      },
    );

    expect(units[0]).toMatchObject({
      statusAccessors: ["status_code"],
      successAccessors: ["ok"],
      bodyAccessors: ["json"],
      failureDelivery: "response",
    });
  });

  it("gives one branch per path the caller takes after the call", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "def load():",
        '    response = httpclient.get("/orders")',
        "    if response.status_code == 404:",
        "        return None",
        "    return response.json()",
      ].join("\n"),
    );

    expect(units[0]?.branches).toHaveLength(2);
    expect(units[0]?.branches[0]?.conditions[0]?.structured).toEqual({
      type: "comparison",
      left: {
        type: "dependency",
        name: "response",
        accessChain: ["status_code"],
      },
      op: "eq",
      right: { type: "literal", value: 404 },
    });
  });

  it("keeps one branch for a caller that returns nothing at all", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "def load():",
        '    httpclient.get("/orders")',
      ].join("\n"),
    );

    expect(units[0]?.branches).toHaveLength(1);
    expect(units[0]?.branches[0]?.isDefault).toBe(true);
  });

  it("keeps one branch for a caller that tests nothing", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "def load():",
        '    return httpclient.get("/orders")',
      ].join("\n"),
    );

    expect(units[0]?.branches).toHaveLength(1);
    expect(units[0]?.branches[0]?.isDefault).toBe(true);
  });

  it("reads a call inside a method of a class", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "class Orders:",
        "    def load(self):",
        '        return httpclient.get("/orders")',
      ].join("\n"),
    );

    expect(units).toHaveLength(1);
    expect(units[0]?.identity.name).toBe("load");
  });

  it("takes no session calls when the pack declares no constructor", async () => {
    const units = await unitsIn(
      [
        "import httpclient",
        "",
        "session = httpclient.Session()",
        "",
        "def load():",
        '    return session.get("/orders")',
      ].join("\n"),
      { ...REQUEST_CALLS, receiverConstructors: [] },
    );

    expect(units).toEqual([]);
  });
});
