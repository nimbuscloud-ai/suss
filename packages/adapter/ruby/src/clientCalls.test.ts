import { describe, expect, it } from "vitest";

import { Database, profileEvaluationAsync } from "@suss/datalog";
import {
  constructedFrom,
  httpRequests,
  imported,
  requestRecognizersOf,
  verbs,
} from "@suss/recognize";

import {
  hostArguments,
  httpClientTestPack,
  requestCalls,
  wrappedUrls,
} from "./__fixtures__/httpClientRequests.js";
import { clientCallUnits } from "./clientCalls.js";
import { createFileCache, discoverUnits } from "./discovery.js";
import {
  collectFileConstants,
  emitConstantBindings,
} from "./facts/constants.js";
import { emitValueFacts } from "./facts/values.js";
import { parseRuby } from "./parser.js";
import { bindEvaluator, methodDefinitionsIn } from "./values/evaluator.js";

import type { RawCodeStructure } from "@suss/extractor";
import type { HttpRequests } from "@suss/recognize";
import type { RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";

const PACK = httpClientTestPack();

const FILE = "app/clients/order_client.rb";

/** The file's tree, with the facts a run states about it. */
async function factsFor(
  source: string,
): Promise<{ root: RbNode; facts: Database }> {
  const tree = await parseRuby(source);
  const facts = new Database();
  emitValueFacts(facts, FILE, tree.rootNode);
  emitConstantBindings(facts, [collectFileConstants(FILE, tree.rootNode)]);
  bindEvaluator(facts, {
    files: [{ file: FILE, root: tree.rootNode }],
    definitions: methodDefinitionsIn(FILE, tree.rootNode),
  });
  return { root: tree.rootNode, facts };
}

async function unitsIn(
  source: string,
  requests: readonly HttpRequests[] = requestCalls(),
): Promise<RawCodeStructure[]> {
  return unitsOf(source, httpClientTestPack(requests));
}

async function unitsOf(
  source: string,
  ...packs: RubyPack[]
): Promise<RawCodeStructure[]> {
  const { root, facts } = await factsFor(source);
  return clientCallUnits(root, packs, { filePath: FILE, facts });
}

/** Each branch of a unit as its terminal kind and the conditions on it. */
function outline(unit: RawCodeStructure | undefined): string[] {
  return (unit?.branches ?? []).map(
    (branch) =>
      `${branch.terminal.kind} ${branch.conditions
        .map((condition) => `${condition.polarity} ${condition.sourceText}`)
        .join(" & ")}`,
  );
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

/** Every unit's REST path, sorted, with the empty string for a unit bound to something else. */
function paths(units: RawCodeStructure[]): string[] {
  return units
    .map((unit) => {
      const semantics = unit.boundaryBinding?.semantics;
      return semantics?.name === "rest" ? (semantics.path ?? "") : "";
    })
    .sort();
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
        '    conn.get("orders")',
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

  it("keeps the host of an absolute URL, from the call or from the builder", async () => {
    const units = await unitsIn(
      [
        "class SearchClient",
        "  def search(query)",
        '    HttpClient.get("https://www.example.net/customsearch/v1?q=#{query}")',
        "  end",
        "  def keys",
        '    conn = HttpClient.build(base: "https://keys.example.org")',
        '    conn.get("/auth/keys")',
        "  end",
        "  def mirror",
        '    conn = HttpClient.build(base: "https://keys.example.org/v2")',
        '    conn.get("https://mirror.example.org/auth/keys")',
        "  end",
        "  def local",
        '    HttpClient.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(
      units.map((unit) => {
        const semantics = unit.boundaryBinding?.semantics;
        return semantics?.name === "rest"
          ? [semantics.path, semantics.host ?? null]
          : null;
      }),
    ).toEqual([
      ["/customsearch/v1", "www.example.net"],
      ["/auth/keys", "keys.example.org"],
      ["/auth/keys", "mirror.example.org"],
      ["/orders", null],
    ]);
  });

  it("finds no path in a URL whose scheme and authority are both holes", async () => {
    const units = await unitsIn(
      [
        "class UploadCheck",
        "  def verify(upload)",
        '    HttpClient.get("#{scheme}:#{upload.url}")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toHaveLength(1);
    expect(boundary(units)).toEqual({ method: "GET", path: null });
  });

  it("is a client with no path for a URL made only of holes", async () => {
    const units = await unitsIn(
      [
        "class ProxyClient",
        "  def get(base_url, path)",
        '    HttpClient.get("#{base_url}#{path}")',
        "  end",
        "  def get_under(base_url, path)",
        '    HttpClient.get("#{base_url}/#{path}")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(paths(units)).toEqual(["", ""]);
  });

  it("keeps a path made only of holes at a host suss read, from the call or from the builder", async () => {
    const units = await unitsIn(
      [
        "class KeyClient",
        "  def key(kid)",
        '    HttpClient.get("https://keys.example.com/#{kid}")',
        "  end",
        "  def key_on(kid)",
        '    conn = HttpClient.build(base: "https://keys.example.com/v1")',
        '    conn.get("#{kid}")',
        "  end",
        "  def key_anywhere(base, kid)",
        "    conn = HttpClient.build(base: base)",
        '    conn.get("#{kid}")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(
      units.map((unit) => {
        const semantics = unit.boundaryBinding?.semantics;
        return semantics?.name === "rest"
          ? [semantics.host ?? null, semantics.path]
          : null;
      }),
    ).toEqual([
      ["keys.example.com", "/{kid}"],
      ["keys.example.com", "/v1/{kid}"],
      [null, null],
    ]);
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
      requestCalls({
        response: {
          statusCode: ["status"],
          success: ["success?"],
          body: ["body"],
          failureDelivery: "response",
          redirectDelivery: "response",
        },
      }),
    );

    expect(units[0]).toMatchObject({
      statusAccessors: ["status"],
      successAccessors: ["success?"],
      bodyAccessors: ["body"],
      failureDelivery: "response",
      redirectDelivery: "response",
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

  it("gives each arm of a success test a branch when neither arm returns", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def refresh",
        '    response = HttpClient.get("/orders")',
        "    if response.success?",
        "      @orders = response.body",
        "    else",
        "      @orders = []",
        "    end",
        "    @loaded = true",
        "  end",
        "end",
      ].join("\n"),
      requestCalls({ response: { success: ["success?"] } }),
    );

    const conditions = (units[0]?.branches ?? []).map((branch) =>
      branch.conditions.map(
        (condition) => `${condition.polarity} ${condition.sourceText}`,
      ),
    );
    expect(conditions).toEqual([
      [],
      ["positive response.success?"],
      ["negative response.success?"],
    ]);
  });

  it("ends a path where the caller raises on a failed response", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    response = HttpClient.get("/orders")',
        '    raise NotFound, "no orders" if response.status == 404',
        "    begin",
        '      raise "caught here"',
        "    rescue StandardError",
        "      nil",
        "    end",
        "    response.body",
        "  end",
        "end",
      ].join("\n"),
    );

    // The raise in the begin block is caught there, so it ends no path.
    expect(outline(units[0])).toEqual([
      "throw positive response.status == 404",
      "return negative response.status == 404 & positive catch",
    ]);
    expect(units[0]?.branches[0]?.terminal).toMatchObject({
      exceptionType: "NotFound",
      message: "no orders",
    });
  });

  it("reads the status test in a helper the caller hands the response to", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def check_response(resp)",
        '    raise "request failed" if resp.status >= 400',
        "    resp.body",
        "  end",
        "",
        "  def load",
        '    response = HttpClient.get("/orders")',
        "    check_response(response)",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(outline(units[0])).toEqual([
      "throw positive resp.status >= 400",
      "return negative resp.status >= 400",
    ]);
    expect(units[0]?.branches[0]?.conditions[0]?.structured).toMatchObject({
      left: { type: "dependency", name: "response", accessChain: ["status"] },
    });
    expect(units[0]?.branches[0]?.terminal).toMatchObject({
      exceptionType: "RuntimeError",
      location: { start: 9, end: 9 },
    });
  });

  it("follows a helper handed the response by keyword, or its parsed body", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def unwrap(payload)",
        "    raise payload.error if payload.error",
        "    payload.data",
        "  end",
        "",
        "  def ensure_ok(label, resp:)",
        '    raise "server error" if resp.status >= 500',
        "  end",
        "",
        "  def load",
        '    response = HttpClient.get("/orders")',
        '    ensure_ok("orders", resp: response)',
        "    payload = response.body",
        "    unwrap(payload)",
        "  end",
        "end",
      ].join("\n"),
      requestCalls({ response: { body: ["body"] } }),
    );

    expect(outline(units[0])).toEqual([
      "throw positive resp.status >= 500",
      "throw negative resp.status >= 500 & positive payload.error",
      "return negative resp.status >= 500 & negative payload.error",
    ]);
  });

  it("leaves the caller alone when the helper never tests what it got", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def record(resp, label)",
        '    raise "no label" if label.nil?',
        "  end",
        "",
        "  def load",
        '    response = HttpClient.get("/orders")',
        '    record(response, "orders")',
        "    response",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(outline(units[0])).toEqual(["return "]);
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
      requestCalls({ constant: "Net::HTTP" }),
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
      requestCalls({ built: false }),
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
      [
        httpRequests({
          client: constructedFrom({ from: ["HttpClient"], named: ["build"] }),
        })
          .methods({ get: { sends: "GET", url: { at: 0 } } })
          .baseUrl({ at: 0, joins: "resolved" }),
      ],
    );

    expect(boundary(units).path).toBe("/orders");
  });

  it("reads the request an endless method makes", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        '  def load = HttpClient.get("/orders")',
        "end",
      ].join("\n"),
    );

    expect(units.map((unit) => unit.identity.name)).toEqual(["load"]);
    expect(boundary(units)).toEqual({ method: "GET", path: "/orders" });
  });

  it("reads calls on a library class the project reopens", async () => {
    const units = await unitsIn(
      [
        "class HttpClient",
        "  def extra; end",
        "end",
        "",
        "class OrderClient",
        "  def load",
        '    HttpClient.get("/orders")',
        "  end",
        "  def save",
        '    conn = HttpClient.build(base: "https://api.example.com/v2")',
        '    conn.post("orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(paths(units)).toEqual(["/orders", "/v2/orders"]);
  });

  it("reads a call on a value the builder made in place", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    HttpClient.build(base: "https://api.example.com/v2").get("orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(units).path).toBe("/v2/orders");
  });

  it("reads a builder's base URL however its key is written", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        '    conn = HttpClient.build(:base => "https://api.example.com/v2")',
        '    conn.get("orders")',
        "  end",
        "  def save",
        '    conn = HttpClient.build("base" => "https://api.example.com/v3")',
        '    conn.post("orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(paths(units)).toEqual(["/v2/orders", "/v3/orders"]);
  });
});

const WRAPPED_URLS = wrappedUrls();

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

  it("reads a request object a method of the file returned", async () => {
    const units = await unitsIn(
      [
        "def load(body)",
        "  conn = HttpClient.build",
        "  conn.send_it(order_request())",
        "end",
        "",
        "def order_request",
        '  HttpClient::Post.new(URI("https://api.example.com/orders"))',
        "end",
      ].join("\n"),
      WRAPPED_URLS,
    );

    expect(boundary(units)).toEqual({ method: "POST", path: "/orders" });
  });

  it("reads the last request object written to a name", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load(body)",
        "    conn = HttpClient.build",
        '    request = HttpClient::Post.new(URI("https://api.example.com/drafts"))',
        '    request = HttpClient::Post.new(URI("https://api.example.com/orders"))',
        "    conn.send_it(request)",
        "  end",
        "end",
      ].join("\n"),
      WRAPPED_URLS,
    );

    expect(boundary(units).path).toBe("/orders");
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

  it("says nothing about a request object a class method other than new made", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load(body)",
        "    conn = HttpClient.build",
        '    conn.send_it(HttpClient::Post.create(URI("https://api.example.com/orders")))',
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

  it("is a client with no path for a URL handed in whole", async () => {
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

    expect(units).toHaveLength(1);
    expect(boundary(units)).toEqual({ method: "GET", path: null });
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

describe("a path under the base its connection was built with", () => {
  /** The path `conn.get(path)` goes to on a connection built on `base`. */
  async function pathUnder(base: string, path: string): Promise<string> {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def load",
        `    conn = HttpClient.build(base: "${base}")`,
        `    conn.get("${path}")`,
        "  end",
        "end",
      ].join("\n"),
    );
    return boundary(units).path ?? "";
  }

  it("goes after the base's path when it is relative", async () => {
    expect(await pathUnder("https://api.example.com/v1", "orders")).toBe(
      "/v1/orders",
    );
    expect(await pathUnder("https://api.example.com/v1/", "orders")).toBe(
      "/v1/orders",
    );
    expect(await pathUnder("https://api.example.com", "orders")).toBe(
      "/orders",
    );
  });

  it("replaces the base's path when it starts with a slash", async () => {
    expect(await pathUnder("https://api.example.com/v1", "/orders")).toBe(
      "/orders",
    );
  });

  it("drops a dot segment and takes a double dot back one segment", async () => {
    expect(await pathUnder("https://api.example.com/v1", "./orders")).toBe(
      "/v1/orders",
    );
    expect(
      await pathUnder("https://api.example.com/v1/beta", "../orders"),
    ).toBe("/v1/orders");
    expect(await pathUnder("https://api.example.com/v1", "orders/..")).toBe(
      "/v1/",
    );
  });

  it("keeps every segment of a base path written without a leading slash", async () => {
    expect(await pathUnder("v1/beta", "orders")).toBe("/v1/beta/orders");
  });

  it("keeps a base URL suss could not read in front of the call's path", async () => {
    expect(await pathUnder("#{root}/v1", "/orders")).toBe("{root}/orders");
    expect(await pathUnder("#{root}/v1", "orders")).toBe("{root}/v1/orders");
    expect(await pathUnder("#{root}", "/orders")).toBe("{root}/orders");
    expect(await pathUnder("#{root}", "orders")).toBe("{root}/orders");
  });
});

describe("a host given as an argument of its own", () => {
  const HOST_ARGUMENTS = hostArguments();

  /** The method, host and path of the one request `load` makes. */
  async function requestIn(lines: string[]): Promise<string> {
    const units = await unitsIn(
      ["class OrderClient", "  def load", ...lines, "  end", "end"].join("\n"),
      HOST_ARGUMENTS,
    );
    const semantics = units[0]?.boundaryBinding?.semantics;
    return semantics?.name === "rest"
      ? `${semantics.method} ${semantics.host ?? ""}${semantics.path}`
      : "none";
  }

  it("reads a host, a path and a port where the pack says the method takes them", async () => {
    expect(
      await requestIn([
        '    HttpClient.fetch("api.example.com", "/orders", 8080)',
      ]),
    ).toBe("GET api.example.com:8080/orders");
    expect(
      await requestIn([
        '    HttpClient.fetch("api.example.com", "/orders", nil)',
      ]),
    ).toBe("GET api.example.com/orders");
  });

  it("reads the first argument as the URL when the second is not a path", async () => {
    expect(
      await requestIn([
        '    HttpClient.fetch("https://api.example.com/orders", { "Accept" => "json" })',
      ]),
    ).toBe("GET api.example.com/orders");
    expect(
      await requestIn([
        '    HttpClient.fetch("https://api.example.com/orders")',
      ]),
    ).toBe("GET api.example.com/orders");
  });

  it("takes a host only on the constant, and only for the methods the pack lists", async () => {
    expect(
      await requestIn([
        '    HttpClient.get("https://api.example.com/orders", "/ignored")',
      ]),
    ).toBe("GET api.example.com/orders");
    expect(
      await requestIn([
        '    conn = HttpClient.build("api.example.com")',
        '    conn.fetch("/orders", "/ignored")',
      ]),
    ).toBe("GET api.example.com/orders");
  });

  it("sends a call on a built value to the host and port it was built with", async () => {
    expect(
      await requestIn([
        '    conn = HttpClient.build("api.example.com", 8443)',
        '    conn.get("orders")',
      ]),
    ).toBe("GET api.example.com:8443/orders");
    expect(
      await requestIn([
        "    conn = HttpClient.build",
        '    conn.get("/orders")',
      ]),
    ).toBe("GET /orders");
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
          conn.get("orders/#{id}")
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
          conn.get("orders/#{id}")
        end
      end
    `);

    expect(boundary(units)).toEqual({
      method: "GET",
      path: "/v1/orders/{id}",
    });
  });

  it("serves the calls that go through an instance variable", async () => {
    const units = await unitsIn(`
      class OrderClient
        def initialize
          @conn = HttpClient.build(base: "https://api.example.com/v1")
        end

        def show(id)
          @conn.get("orders/#{id}")
        end
      end
    `);

    expect(boundary(units)).toEqual({
      method: "GET",
      path: "/v1/orders/{id}",
    });
  });

  it("serves the calls that go through a memoised instance method", async () => {
    const units = await unitsIn(`
      class OrderClient
        def conn
          @conn ||= HttpClient.build(base: "https://api.example.com/v1")
        end

        def show(id)
          conn.get("orders/#{id}")
        end
      end
    `);

    expect(boundary(units)).toEqual({
      method: "GET",
      path: "/v1/orders/{id}",
    });
  });

  it("says nothing about an instance variable the library did not build", async () => {
    const units = await unitsIn(`
      class OrderClient
        def initialize
          @conn = something_else
        end

        def show
          @conn.get("/orders")
        end
      end
    `);

    expect(units).toEqual([]);
  });

  it("reads a base URL written as the first argument", async () => {
    const units = await unitsIn(`
      class OrderClient
        def self.conn
          HttpClient.build("https://api.example.com/v1")
        end

        def self.show(id)
          conn.get("orders/#{id}")
        end
      end
    `);

    expect(boundary(units)).toEqual({
      method: "GET",
      path: "/v1/orders/{id}",
    });
  });
});

describe("a URL the constructor was given", () => {
  const RESOURCE = `
      class Resource
        def initialize(base)
          @base = base
        end

        def list
          HttpClient.get(@base)
        end
      end
  `;

  it("gives one client per construction of the class", async () => {
    const units = await unitsIn(`${RESOURCE}
      USERS = Resource.new("/users")
      ORDERS = Resource.new("/orders")
    `);

    expect(paths(units)).toEqual(["/orders", "/users"]);
  });

  it("gives one client when the class is constructed once", async () => {
    const units = await unitsIn(`${RESOURCE}
      USERS = Resource.new("/users")
    `);

    expect(paths(units)).toEqual(["/users"]);
  });

  it("gives one client when two constructions state the same URL", async () => {
    const units = await unitsIn(`${RESOURCE}
      USERS = Resource.new("/users")
      SAME = Resource.new("/users")
    `);

    expect(paths(units)).toEqual(["/users"]);
  });

  it("gives one client with no path when nothing constructs the class", async () => {
    const units = await unitsIn(RESOURCE);

    expect(units).toHaveLength(1);
    expect(boundary(units)).toEqual({ method: "GET", path: null });
  });

  it("leaves out a construction whose URL says nothing, when another one does", async () => {
    const units = await unitsIn(`${RESOURCE}
      USERS = Resource.new("/users")

      def build(base)
        Resource.new(base)
      end
    `);

    expect(paths(units)).toEqual(["/users"]);
  });
});

describe("a pack declared with @suss/recognize", () => {
  const DECLARED: RubyPack = {
    name: "declared",
    protocol: "http",
    discovery: [],
    requestRecognizers: requestRecognizersOf([
      httpRequests({ client: imported({ from: ["HttpClient"], named: ["*"] }) })
        .methods(verbs({ get: "GET" }, { at: 0 }))
        .response({ statusCode: ["status"] }),
    ]),
  };

  /** Each unit's name and its request, in the order they come back. */
  function requests(units: RawCodeStructure[]): string[] {
    return units.map((unit) => {
      const semantics = unit.boundaryBinding?.semantics;
      return semantics?.name === "rest"
        ? `${unit.identity.name} ${semantics.method} ${semantics.path}`
        : unit.identity.name;
    });
  }

  it("makes a method that calls the library a client, with the response members it declares", async () => {
    const units = await unitsOf(
      [
        "class OrderClient",
        "  def load",
        '    HttpClient.get("/orders")',
        "  end",
        "end",
      ].join("\n"),
      DECLARED,
    );

    expect(requests(units)).toEqual(["load GET /orders"]);
    expect(units[0]?.statusAccessors).toEqual(["status"]);
  });

  it("keeps each pack's units together, in the order the packs run", async () => {
    const units = await unitsOf(
      [
        "class OrderClient",
        "  def first",
        '    HttpClient.get("/a")',
        "  end",
        "  def second",
        '    OtherClient.get("/b")',
        "  end",
        "  def third",
        '    HttpClient.get("/c")',
        "  end",
        "end",
      ].join("\n"),
      DECLARED,
      httpClientTestPack(requestCalls({ constant: "OtherClient" })),
    );

    expect(requests(units)).toEqual([
      "first GET /a",
      "third GET /c",
      "second GET /b",
    ]);
  });

  it("reads a pack's calls on the constant and on a built value in the order the file writes them", async () => {
    const units = await unitsOf(
      [
        "class OrderClient",
        "  def first",
        '    conn = HttpClient.build("api.example.com")',
        '    conn.get("/a")',
        "  end",
        "  def second",
        '    HttpClient.fetch("api.example.com", "/b")',
        "  end",
        "end",
      ].join("\n"),
      httpClientTestPack(hostArguments()),
    );

    expect(requests(units)).toEqual(["first GET /a", "second GET /b"]);
  });
});

describe("a file with several call sites", () => {
  /** A class that keeps one connection per name and calls through each of them. */
  function clientOver(names: readonly string[]): string {
    return [
      "class OrderClient",
      "  def initialize",
      ...names.map(
        (name) => `    @${name} = HttpClient.build(base: "/${name}")`,
      ),
      "  end",
      ...names.flatMap((name) => [
        `  def load_${name}`,
        `    @${name}.get("recent")`,
        "  end",
      ]),
      "end",
    ].join("\n");
  }

  async function discovered(source: string) {
    const { root, facts } = await factsFor(source);
    return profileEvaluationAsync(() =>
      discoverUnits(root, {
        packs: [PACK],
        filePath: FILE,
        cache: createFileCache(
          (text) => parseRuby(text).then((parsed) => parsed.rootNode),
          () => null,
        ),
        facts,
      }),
    );
  }

  it("asks the rules as many times for six sites as for three", async () => {
    const three = await discovered(clientOver(["carts", "orders", "users"]));
    const six = await discovered(
      clientOver(["carts", "items", "orders", "prices", "stock", "users"]),
    );

    expect(paths(three.result)).toEqual([
      "/carts/recent",
      "/orders/recent",
      "/users/recent",
    ]);
    expect(six.result).toHaveLength(6);
    expect(six.profile.evaluations).toEqual(three.profile.evaluations);
    // Two rounds, each of which asks a second time about a key the
    // first round settled on a call.
    expect(three.profile.evaluations).toBeLessThanOrEqual(4);
  });
});
