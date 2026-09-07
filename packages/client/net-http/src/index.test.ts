import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractRubyProject } from "@suss/adapter-ruby";

import { netHttpClient } from "./index.js";

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

  it("says nothing about a URL that does not settle on a string", async () => {
    const summaries = await summariesOf(
      [
        "class OrderClient",
        "  def fetch(target)",
        "    Net::HTTP.get(URI(target))",
        "  end",
        "end",
      ].join("\n"),
    );

    expect(summaries).toEqual([]);
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
    // A summary carries the condition itself, past the reading a raw
    // structure holds it in.
    expect(summaries[0]?.transitions[0]?.conditions[0]).toMatchObject({
      type: "comparison",
      left: { type: "dependency", accessChain: ["code"] },
      right: { value: 404 },
    });
  });
});
