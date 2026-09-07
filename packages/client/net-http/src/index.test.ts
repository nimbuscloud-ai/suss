import { describe, expect, it } from "vitest";

import { discoverUnits, parseRuby } from "@suss/adapter-ruby";

import { netHttpClient } from "./index.js";

import type { RawCodeStructure } from "@suss/extractor";

async function unitsIn(source: string): Promise<RawCodeStructure[]> {
  const tree = await parseRuby(source);
  return discoverUnits(tree.rootNode, {
    packs: [netHttpClient()],
    filePath: "app/clients/order_client.rb",
    cache: { get: async () => null },
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

describe("a method that calls Net::HTTP", () => {
  it("reads the URL a call wraps in URI", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def fetch",
        '    Net::HTTP.get(URI("https://api.example.com/orders"))',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toHaveLength(1);
    expect(units[0]?.identity.kind).toBe("client");
    expect(boundary(units)).toEqual({ method: "GET", path: "/orders" });
  });

  it("reads a URI held in a local, written with parse", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def fetch(id)",
        '    uri = URI.parse("https://api.example.com/orders/#{id}")',
        "    Net::HTTP.get_response(uri)",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(units)).toEqual({ method: "GET", path: "/orders/{id}" });
  });

  it("reads the method a posted form sends", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def create(params)",
        '    Net::HTTP.post_form(URI("https://api.example.com/orders"), params)',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(units)).toEqual({ method: "POST", path: "/orders" });
  });

  it("reads a request object built in several steps", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def create(body)",
        '    uri = URI("https://api.example.com/orders")',
        "    http = Net::HTTP.new(uri.host, uri.port)",
        "    request = Net::HTTP::Post.new(uri)",
        "    request.body = body",
        "    http.request(request)",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(units)).toEqual({ method: "POST", path: "/orders" });
  });

  it("reads a request object built in the call itself", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def drop(id)",
        '    uri = URI("https://api.example.com/orders/#{id}")',
        "    http = Net::HTTP.new(uri.host, uri.port)",
        "    http.request(Net::HTTP::Delete.new(uri))",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(units)).toEqual({
      method: "DELETE",
      path: "/orders/{id}",
    });
  });

  it("says nothing about a request class the library does not define", async () => {
    const units = await unitsIn(
      [
        "class OrderClient",
        "  def send_it",
        '    uri = URI("https://api.example.com/orders")',
        "    http = Net::HTTP.new(uri.host, uri.port)",
        "    http.request(OurOwn::Request.new(uri))",
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
        "    Net::HTTP.get(URI(target))",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });
});
