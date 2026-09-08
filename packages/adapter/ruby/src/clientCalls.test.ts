import { describe, expect, it } from "vitest";

import { clientCallUnits } from "./clientCalls.js";
import { parseRuby } from "./parser.js";

import type { RawCodeStructure } from "@suss/extractor";
import type { RbClientCall, RubyPack } from "./pack.js";

/** A library like Faraday, written the way a pack writes one. */
const REQUEST_CALLS: RbClientCall = {
  constantName: "HttpClient",
  verbMethodNames: { get: "GET", post: "POST" },
  url: { position: 0, keyword: "url" },
  receiverBuilders: ["build"],
  builderUrlKeyword: "base",
};

const PACK: RubyPack = {
  name: "httpclient",
  protocol: "http",
  discovery: [],
  clients: [REQUEST_CALLS],
};

async function unitsIn(
  source: string,
  pattern: RbClientCall = REQUEST_CALLS,
): Promise<RawCodeStructure[]> {
  const tree = await parseRuby(source);
  return clientCallUnits(tree.rootNode, PACK, pattern, {
    filePath: "app/clients/order_client.rb",
  });
}

/** The method and path of the first unit. */
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

describe("a method that calls a request method", () => {
  it("is a client of the boundary the call states", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    HttpClient.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toHaveLength(1);
    expect(units[0]?.identity.exportPath).toEqual(["load"]);
    expect(boundary(units)).toEqual({ method: "GET", path: "/orders" });
  });

  it("reads the URL written under the keyword", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    HttpClient.get(url: "/orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(units).path).toBe("/orders");
  });

  it("is a client of both boundaries when it calls twice", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def sync",
        '    HttpClient.get("/orders")',
        '    HttpClient.post("/audit")',
        "  end",
        "end",
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

  it("reads a call on a value one of the library's builders made", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    conn = HttpClient.build(base: "https://api.example.com/v2")',
        '    conn.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(units).path).toBe("/v2/orders");
  });

  it("takes a builder's bare host as no path at all", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    conn = HttpClient.build(base: "https://api.example.com/")',
        '    conn.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(units).path).toBe("/orders");
  });

  it("says nothing about a receiver the library did not build", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        "    conn = something_else",
        '    conn.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("says nothing about a builder call on another constant", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    conn = OtherClient.build(base: "/v2")',
        '    conn.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("says which members of the response mean what, when the pack said", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    HttpClient.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
      {
        ...REQUEST_CALLS,
        response: {
          statusCode: ["status"],
          success: ["success?"],
          body: ["body"],
          failureDelivery: "response",
        },
      },
    );

    expect(units[0]).toMatchObject({
      statusAccessors: ["status"],
      successAccessors: ["success?"],
      bodyAccessors: ["body"],
      failureDelivery: "response",
    });
  });

  it("gives one branch per path the caller takes after the call", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    response = HttpClient.get("/orders")',
        "    return nil if response.status == 404",
        "",
        "    response.body",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units[0]?.branches).toHaveLength(2);
    expect(units[0]?.branches[0]?.conditions[0]?.structured).toMatchObject({
      type: "comparison",
      left: { type: "dependency", name: "response", accessChain: ["status"] },
      right: { type: "literal", value: 404 },
    });
  });

  it("says nothing about a receiverless call of the same name", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    get("/orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("says nothing about a call whose receiver is itself a call", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    registry.connection.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("says nothing about a method with an empty body", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        "  end",
        "  def other",
        '    conn.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("says nothing about a method the pack declares no request for", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    HttpClient.stream("/orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("says nothing about a call with no arguments", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        "    HttpClient.get",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("reads a call on a constant written with its namespace", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    Net::HTTP.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
      { ...REQUEST_CALLS, constantName: "Net::HTTP" },
    );

    expect(boundary(units).method).toBe("GET");
  });

  it("reads a call inside a method defined on the class itself", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def self.load",
        '    HttpClient.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toHaveLength(1);
    expect(units[0]?.identity.name).toBe("load");
  });

  it("takes no builder calls when the pack declares no builder", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    conn = HttpClient.build(base: "/v2")',
        '    conn.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
      { ...REQUEST_CALLS, receiverBuilders: [] },
    );

    expect(units).toEqual([]);
  });

  it("takes a builder with no URL keyword declared as no prefix", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    conn = HttpClient.build(base: "/v2")',
        '    conn.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
      {
        constantName: "HttpClient",
        verbMethodNames: { get: "GET" },
        url: { position: 0 },
        receiverBuilders: ["build"],
      },
    );

    expect(boundary(units).path).toBe("/orders");
  });
});

/** A library that sends a request built somewhere else. */
const WRAPPED_URLS: RbClientCall = {
  constantName: "HttpClient",
  verbMethodNames: { get: "GET" },
  url: { position: 0 },
  receiverBuilders: ["build"],
  requestObject: {
    attribute: "send_it",
    constructors: { "HttpClient::Post": "POST" },
    urlPosition: 0,
  },
};

describe("a library that sends a request object", () => {
  it("reads a URL the standard library wrapped in a URI", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    HttpClient.get(URI("https://api.example.com/orders"))',
        "  end",
        "end",
      ].join("\n"),
      WRAPPED_URLS,
    );

    expect(boundary(units)).toEqual({ method: "GET", path: "/orders" });
  });

  it("reads the request object a call was handed", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load(body)",
        "    conn = HttpClient.build",
        '    request = HttpClient::Post.new(URI("https://api.example.com/orders"))',
        "    conn.send_it(request)",
        "  end",
        "end",
      ].join("\n"),
      WRAPPED_URLS,
    );

    expect(boundary(units)).toEqual({ method: "POST", path: "/orders" });
  });

  it("says nothing about a request object of a class the pack does not declare", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load(body)",
        "    conn = HttpClient.build",
        '    conn.send_it(OurOwn::Post.new(URI("https://api.example.com/orders")))',
        "  end",
        "end",
      ].join("\n"),
      WRAPPED_URLS,
    );

    expect(units).toEqual([]);
  });

  it("says nothing about a request call handed no argument at all", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        "    conn = HttpClient.build",
        "    conn.send_it",
        "  end",
        "end",
      ].join("\n"),
      WRAPPED_URLS,
    );

    expect(units).toEqual([]);
  });

  it("says nothing about a URL handed in whole, which names no route", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load(target)",
        "    HttpClient.get(URI(target))",
        "  end",
        "end",
      ].join("\n"),
      WRAPPED_URLS,
    );

    expect(units).toEqual([]);
  });

  it("reads a plain string where the library also takes one", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    HttpClient.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
      WRAPPED_URLS,
    );

    expect(boundary(units).path).toBe("/orders");
  });
});

describe("a connection the class builds in a method of its own", () => {
  it("serves the calls that go through it", async () => {
    const units = await unitsIn(`
      class OrderClient
        def self.conn
          HttpClient.build(base: "https://api.example.com/v1")
        end

        def self.show(id)
          conn.get("/orders/#{id}")
        end
      end
    `);

    expect(boundary(units)).toEqual({
      method: "GET",
      path: "/v1/orders/{id}",
    });
  });

  it("follows a connection the class keeps after the first call", async () => {
    const units = await unitsIn(`
      class OrderClient
        def self.conn
          @conn ||= HttpClient.build(base: "https://api.example.com/v1")
        end

        def self.show(id)
          conn.get("/orders/#{id}")
        end
      end
    `);

    expect(boundary(units)).toEqual({
      method: "GET",
      path: "/v1/orders/{id}",
    });
  });

  it("reads a base URL written as the first argument", async () => {
    const units = await unitsIn(`
      class OrderClient
        def self.conn
          HttpClient.build("https://api.example.com/v1")
        end

        def self.show(id)
          conn.get("/orders/#{id}")
        end
      end
    `);

    expect(boundary(units)).toEqual({
      method: "GET",
      path: "/v1/orders/{id}",
    });
  });
});
