import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractRubyProject } from "@suss/adapter-ruby";

import { NET_HTTP, NET_HTTP_CONNECTION, netHttpClient } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

let projectDir: string | null = null;

afterEach(() => {
  if (projectDir !== null) {
    fs.rmSync(projectDir, { recursive: true, force: true });
    projectDir = null;
  }
});

/**
 * The summaries of one file, read the way a run reads a project, so the
 * value facts a name resolves through are the ones a project has.
 */
async function summariesOf(source: string): Promise<BehavioralSummary[]> {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-net-http-"));
  const file = path.join(projectDir, "order_client.rb");
  fs.writeFileSync(file, source);
  const { summaries } = await extractRubyProject({
    files: [file],
    packs: [netHttpClient()],
    workspaceRoot: projectDir,
    cacheDir: null,
  });
  return summaries.filter((summary) => summary.kind === "client");
}

/** The method and path of the first client summary. */
function boundary(summaries: BehavioralSummary[]): {
  method: string | null;
  path: string | null;
} {
  const semantics = summaries[0]?.identity.boundaryBinding?.semantics;
  if (semantics?.name !== "rest") {
    throw new Error(
      `expected a REST boundary, got ${JSON.stringify(semantics)}`,
    );
  }
  return { method: semantics.method, path: semantics.path };
}

/** The method, host and path of the first client summary, as one string. */
async function requestIn(lines: string[]): Promise<string> {
  const summaries = await summariesOf(
    ["class OrderClient", "  def fetch", ...lines, "  end", "end"].join("\n"),
  );
  const semantics = summaries[0]?.identity.boundaryBinding?.semantics;
  if (semantics?.name !== "rest") {
    throw new Error(
      `expected a REST boundary, got ${JSON.stringify(semantics)}`,
    );
  }
  return `${semantics.method} ${semantics.host ?? ""}${semantics.path}`;
}

describe("a method that calls Net::HTTP", () => {
  it("reads the URL a call wraps in URI", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def fetch",
        '    Net::HTTP.get(URI("https://api.example.com/orders"))',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(summaries).toHaveLength(1);
    expect(boundary(summaries)).toEqual({ method: "GET", path: "/orders" });
  });

  it("reads a URI held in a local, written with parse", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def fetch(id)",
        '    uri = URI.parse("https://api.example.com/orders/#{id}")',
        "    Net::HTTP.get_response(uri)",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(summaries)).toEqual({
      method: "GET",
      path: "/orders/{id}",
    });
  });

  it("reads the method a posted form sends", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def create(params)",
        '    Net::HTTP.post_form(URI("https://api.example.com/orders"), params)',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(boundary(summaries)).toEqual({ method: "POST", path: "/orders" });
  });

  it("reads a request object built in several steps", async () => {
    const summaries = await summariesOf(
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

    expect(boundary(summaries)).toEqual({ method: "POST", path: "/orders" });
  });

  it("reads a request object built in the call itself", async () => {
    const summaries = await summariesOf(
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

    expect(boundary(summaries)).toEqual({
      method: "DELETE",
      path: "/orders/{id}",
    });
  });

  it("says nothing about a request class the library does not define", async () => {
    const summaries = await summariesOf(
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

    expect(summaries).toEqual([]);
  });

  it("is a client with no path for a URL that does not settle on a string", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def fetch(target)",
        "    Net::HTTP.get(URI(target))",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(summaries).toHaveLength(1);
    expect(boundary(summaries)).toEqual({ method: "GET", path: null });
  });
});

describe("a host and a path given apart", () => {
  it("reads the host, the path and the port of a get method", async () => {
    expect(
      await requestIn([
        '    Net::HTTP.get("api.example.com", "/orders", 8080)',
      ]),
    ).toBe("GET api.example.com:8080/orders");
    expect(
      await requestIn([
        '    Net::HTTP.get_response("api.example.com", "/orders")',
      ]),
    ).toBe("GET api.example.com/orders");
    expect(
      await requestIn([
        '    Net::HTTP.get_print("api.example.com", "/orders", 80)',
      ]),
    ).toBe("GET api.example.com/orders");
  });

  it("reads a host and a port kept in constants", async () => {
    const summaries = await summariesOf(
      [
        'DEBUG_HOST = ENV["DEBUG_HOST"] || "127.0.0.1"',
        "DEBUG_PORT = 9222",
        "class OrderClient",
        "  def fetch",
        '    Net::HTTP.get(DEBUG_HOST, "/json/list", DEBUG_PORT)',
        "  end",
        "end",
      ].join("\n"),
    );

    expect(summaries[0]?.identity.boundaryBinding?.semantics).toMatchObject({
      method: "GET",
      path: "/json/list",
      host: "127.0.0.1:9222",
    });
  });

  it("reads the first argument as the URL when the second is a hash of headers", async () => {
    expect(
      await requestIn([
        "    headers = {}",
        '    Net::HTTP.get(URI("https://cdn.example.com/assets/app.css"), headers)',
      ]),
    ).toBe("GET cdn.example.com/assets/app.css");
    expect(
      await requestIn([
        '    Net::HTTP.get(URI("https://cdn.example.com/assets/app.css"), { "Accept" => "text/css" })',
      ]),
    ).toBe("GET cdn.example.com/assets/app.css");
  });

  it("reads a host-first call on a connection as a path and its headers", async () => {
    expect(
      await requestIn([
        '    http = Net::HTTP.new("api.example.com")',
        '    http.get("/orders", "/ignored")',
      ]),
    ).toBe("GET api.example.com/orders");
  });

  it("sends a connection's calls to the host and port it was built on", async () => {
    expect(
      await requestIn([
        '    http = Net::HTTP.new("api.example.com")',
        '    http.get("/orders")',
      ]),
    ).toBe("GET api.example.com/orders");
    expect(
      await requestIn([
        '    http = Net::HTTP.new("api.example.com", 8443)',
        '    http.request(Net::HTTP::Get.new("/orders"))',
      ]),
    ).toBe("GET api.example.com:8443/orders");
  });
});

describe("what a caller does with the response", () => {
  it("reads a status the caller converts before it tests it", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def fetch(id)",
        '    response = Net::HTTP.get_response(URI("https://api.example.com/orders/#{id}"))',
        "    return nil if response.code.to_i == 404",
        "",
        "    response.body",
        "  end",
        "end",
      ].join("\n"),
    );

    const http = summaries[0]?.metadata?.http as
      | { statusAccessors?: string[] }
      | undefined;
    expect(http?.statusAccessors).toEqual(["code"]);
    // The summary records the condition as structure, so the member
    // and the literal can be read off it.
    expect(summaries[0]?.transitions[0]?.conditions[0]).toMatchObject({
      type: "comparison",
      left: { type: "dependency", accessChain: ["code"] },
      right: { value: 404 },
    });
  });
});

describe("the declarations' examples", () => {
  it("make the method each is written in a client", async () => {
    expect(await requestIn([`    ${NET_HTTP.declared.example}`])).toBe(
      "GET api.example.com/orders",
    );
    expect(
      await requestIn([`    ${NET_HTTP_CONNECTION.declared.example}`]),
    ).toBe("GET api.example.com/orders");
  });
});
