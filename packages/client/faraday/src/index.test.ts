import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createConstantFileCache,
  discoverUnits,
  extractRubyProject,
  factsForFile,
  parseRuby,
} from "@suss/adapter-ruby";
import { evalPredicate } from "@suss/behavioral-ir";

import { FARADAY, faradayClient } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { RawCodeStructure } from "@suss/extractor";

const FILE = "app/clients/order_client.rb";

/** The units of one file, with the facts a run would have put in the store. */
async function unitsIn(source: string): Promise<RawCodeStructure[]> {
  const tree = await parseRuby(source);
  const packs = [faradayClient()];
  return discoverUnits(tree.rootNode, {
    packs,
    filePath: FILE,
    cache: {
      get: async () => null,
      constantFiles: createConstantFileCache(),
    },
    facts: factsForFile({ file: FILE, root: tree.rootNode, packs }),
  });
}

/** The method and path of the first unit discovered. */
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

describe("a method that calls Faraday", () => {
  it("is a client of the route the call names", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def fetch(id)",
        '    Faraday.get("https://api.example.com/orders/#{id}")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toHaveLength(1);
    expect(units[0]?.identity.kind).toBe("client");
    expect(units[0]?.identity.name).toBe("fetch");
    expect(boundary(units)).toEqual({
      method: "GET",
      path: "/orders/{id}",
    });
  });

  it("reads a call on a connection the module built", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def create(body)",
        '    conn = Faraday.new(url: "https://api.example.com")',
        '    conn.post("/orders", body)',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(units)).toEqual({ method: "POST", path: "/orders" });
  });

  it("reads run_request, whose method a caller of the helper passes", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def send_request(url, verb = :get, body = nil)",
        "    Faraday.new.run_request(verb, url, body, {})",
        "  end",
        "",
        "  def create(body)",
        '    Faraday.new.run_request(:post, "https://api.example.com/orders", body, {})',
        "  end",
        "end",
      ].join("\n"),
    );
    const [helper, create] = units;

    expect(boundary(units)).toEqual({ method: null, path: null });
    expect(helper?.bindingFrom?.method).toEqual([
      { type: "input", inputRef: "verb", path: [] },
    ]);
    expect(helper?.parameters.map((one) => [one.name, one.default])).toEqual([
      ["url", undefined],
      ["verb", { type: "literal", value: "get" }],
      ["body", { type: "literal", value: null }],
    ]);
    expect(boundary([create as RawCodeStructure])).toEqual({
      method: "POST",
      path: "/orders",
    });
    expect(create?.bindingFrom).toBeUndefined();
  });

  it("serves a connection's relative paths under the path its own URL states", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def create(body)",
        '    conn = Faraday.new(url: "https://api.example.com/v1")',
        '    conn.post("orders", body)',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(units).path).toBe("/v1/orders");
  });

  it("sends a path that starts with a slash to that path, as Faraday resolves it", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def create(body)",
        '    conn = Faraday.new(url: "https://api.example.com/v1")',
        '    conn.post("/orders", body)',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(units).path).toBe("/orders");
  });

  it("keeps a path that starts with // on the connection's host, as Faraday does", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def fetch",
        '    conn = Faraday.new(url: "https://api.example.com/v1")',
        '    conn.get("//other.example.com/orders")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(units).path).toBe("/v1///other.example.com/orders");
    expect(units[0]?.boundaryBinding?.semantics).toMatchObject({
      host: "api.example.com",
    });
  });

  it("says nothing about a call on something else entirely", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def fetch(id)",
        '    HTTParty.get("/orders/#{id}")',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("is a client with no path for a URL that does not settle on a string", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def fetch(target)",
        "    Faraday.get(target)",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toHaveLength(1);
    expect(boundary(units)).toEqual({ method: "GET", path: null });
  });

  it("leaves a call written outside a method alone", async () => {
    const units = await unitsIn('Faraday.get("/health")');

    expect(units).toEqual([]);
  });
});

describe("what a caller does with the response", () => {
  it("says which statuses it handles, so a check can compare them", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def fetch(id)",
        '    response = Faraday.get("/orders/#{id}")',
        "    return nil if response.status == 404",
        "",
        "    response.body",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units[0]?.statusAccessors).toEqual(["status"]);
    expect(units[0]?.branches[0]?.conditions[0]?.structured).toMatchObject({
      type: "comparison",
      left: { type: "dependency", accessChain: ["status"] },
      right: { value: 404 },
    });
  });
});

describe("a class given its path prefix when it was made", () => {
  it("is a client of one route per construction", async () => {
    const units = await unitsIn(
      [
        "class Resource",
        "  def initialize(base)",
        "    @base = base",
        "  end",
        "",
        "  def list",
        "    Faraday.get(@base)",
        "  end",
        "end",
        "",
        'USERS = Resource.new("/users")',
        'ORDERS = Resource.new("/orders")',
      ].join("\n"),
    );

    expect(units.map((unit) => unit.identity.name)).toEqual(["list", "list"]);
    expect(
      units
        .map((unit) => {
          const semantics = unit.boundaryBinding?.semantics;
          return semantics?.name === "rest" ? semantics.path : null;
        })
        .sort(),
    ).toEqual(["/orders", "/users"]);
  });
});

describe("a request a branch before the call picks", () => {
  const root = path.resolve(
    __dirname,
    "../../../../fixtures/branch-picked-request-ruby",
  );

  async function clientsOf(name: string): Promise<BehavioralSummary[]> {
    const { summaries } = await extractRubyProject({
      files: [path.join(root, "app/client.rb")],
      packs: [faradayClient()],
      workspaceRoot: root,
      cacheDir: null,
    });
    return summaries.filter(
      (summary) => summary.kind === "client" && summary.identity.name === name,
    );
  }

  function requestOf(client: BehavioralSummary): string {
    const semantics = client.identity.boundaryBinding?.semantics;
    return semantics?.name === "rest"
      ? `${semantics.method} ${semantics.path}`
      : "";
  }

  /** The requests whose condition comes out true when the caller passes these arguments. */
  function sentWith(
    clients: readonly BehavioralSummary[],
    env: Record<string, unknown>,
  ): string[] {
    return clients
      .filter((client) =>
        (client.bindingFrom?.when ?? []).every(
          (one) => evalPredicate(one, env) === "true",
        ),
      )
      .map(requestOf);
  }

  it("makes one client per arm of a record a branch picks, each under its arm's condition", async () => {
    const clients = await clientsOf("save_sprocket");
    expect(sentWith(clients, { sprocket: { id: "s1" } })).toEqual([
      "PATCH /sprockets/{param}",
    ]);
    expect(sentWith(clients, { sprocket: {} })).toEqual(["POST /sprockets"]);
  });

  it("makes one client per URL a branch picks under a fixed method", async () => {
    const clients = await clientsOf("load_gizmo");
    expect(sentWith(clients, { gizmo_id: "g1" })).toEqual([
      "GET /gizmos/{gizmo_id}",
    ]);
    expect(sentWith(clients, { gizmo_id: null })).toEqual(["GET /gizmos"]);
  });

  it("makes one client per method a branch picks for a fixed URL", async () => {
    const clients = await clientsOf("toggle_widget");
    expect(sentWith(clients, { on: true })).toEqual(["PUT /widgets/current"]);
    expect(sentWith(clients, { on: false })).toEqual([
      "DELETE /widgets/current",
    ]);
  });

  it("makes one client per arm of a case", async () => {
    const clients = await clientsOf("fetch_report");
    expect(clients.map(requestOf).sort()).toEqual([
      "GET /reports/all",
      "GET /reports/daily",
      "GET /reports/weekly",
    ]);
    expect(sentWith(clients, { period: "day" })).toContain(
      "GET /reports/daily",
    );
    expect(sentWith(clients, { period: "fortnight" })).toContain(
      "GET /reports/weekly",
    );
    expect(sentWith(clients, { period: "day" })).not.toContain(
      "GET /reports/weekly",
    );
  });

  it("keeps one client when the branch changes neither the method nor the URL", async () => {
    const clients = await clientsOf("ping_doohickey");
    expect(clients.map(requestOf)).toEqual(["POST /doohickeys/ping"]);
    expect(clients[0]?.bindingFrom).toBeUndefined();
  });
});

describe("the declaration's example", () => {
  it("makes the method it is written in a client", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def example",
        `    ${FARADAY.declared.example}`,
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(units)).toEqual({ method: "GET", path: "/v1/orders" });
  });
});
