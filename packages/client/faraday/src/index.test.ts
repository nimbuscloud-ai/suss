import { describe, expect, it } from "vitest";

import { discoverUnits, factsForFile, parseRuby } from "@suss/adapter-ruby";

import { faradayClient } from "./index.js";

import type { RawCodeStructure } from "@suss/extractor";

const FILE = "app/clients/order_client.rb";

/** The units of one file, with the facts a run would have put in the store. */
async function unitsIn(source: string): Promise<RawCodeStructure[]> {
  const tree = await parseRuby(source);
  const packs = [faradayClient()];
  return discoverUnits(tree.rootNode, {
    packs,
    filePath: FILE,
    cache: { get: async () => null },
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

  it("serves a connection's calls under the path its own URL states", async () => {
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

    expect(boundary(units).path).toBe("/v1/orders");
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

  it("says nothing about a URL that does not settle on a string", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def fetch(target)",
        "    Faraday.get(target)",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toEqual([]);
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
