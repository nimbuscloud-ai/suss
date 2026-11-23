import { describe, expect, it } from "vitest";

import {
  bindModule,
  discoverUnits,
  factsForFile,
  parsePython,
} from "@suss/adapter-python";

import { AIOHTTP, aiohttpClient } from "./index.js";

import type { RawCodeStructure } from "@suss/extractor";

const FILE = "app/orders.py";

async function unitsIn(source: string): Promise<RawCodeStructure[]> {
  const tree = await parsePython(source);
  const root = tree.rootNode;
  const module = bindModule(root);
  const packs = [aiohttpClient()];
  return discoverUnits(root, module, {
    packs,
    filePath: FILE,
    facts: factsForFile({ file: FILE, root, module, packs }),
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

describe("a function that calls aiohttp", () => {
  it("is a client of the route a session call names", async () => {
    const units = await unitsIn(
      [
        "import aiohttp",
        "",
        "async def fetch_order(order_id):",
        "    async with aiohttp.ClientSession() as session:",
        '        async with session.get(f"/orders/{order_id}") as response:',
        "            return await response.json()",
      ].join("\n"),
    );

    expect(units).toHaveLength(1);
    expect(units[0]?.identity.name).toBe("fetch_order");
    expect(boundary(units)).toEqual({
      method: "GET",
      path: "/orders/{order_id}",
    });
  });

  it("reads a session held in a plain assignment", async () => {
    const units = await unitsIn(
      [
        "import aiohttp",
        "",
        "async def create_order(body):",
        "    session = aiohttp.ClientSession()",
        '    return await session.post("/orders", json=body)',
      ].join("\n"),
    );

    expect(boundary(units)).toEqual({ method: "POST", path: "/orders" });
  });

  it("says the method comes from the helper's parameter, with its default", async () => {
    const units = await unitsIn(
      [
        "import aiohttp",
        "",
        'async def send(url, method="GET"):',
        "    async with aiohttp.ClientSession() as session:",
        "        return await session.request(method, url)",
      ].join("\n"),
    );

    expect(boundary(units).method).toBeNull();
    expect(units[0]?.bindingFrom?.method).toEqual([
      { type: "input", inputRef: "method", path: [] },
    ]);
    expect(units[0]?.parameters[1]?.default).toEqual({
      type: "literal",
      value: "GET",
    });
  });

  it("says nothing about a session this run cannot see built", async () => {
    const units = await unitsIn(
      [
        "import aiohttp",
        "",
        "async def fetch_order(session, order_id):",
        '    return await session.get(f"/orders/{order_id}")',
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });
});

describe("what a session call does with a redirect", () => {
  async function deliveryOf(call: string): Promise<unknown> {
    const units = await unitsIn(
      [
        "import aiohttp",
        "",
        "async def probe():",
        "    session = aiohttp.ClientSession()",
        `    return await session.${call}`,
      ].join("\n"),
    );
    expect(units).toHaveLength(1);
    return units[0]?.redirectDelivery;
  }

  it("hands a redirect back from head, whose allow_redirects defaults to False", async () => {
    expect(await deliveryOf('head("/orders")')).toBe("response");
    expect(await deliveryOf('head("/orders", allow_redirects=True)')).toBe(
      "followed",
    );
  });

  it("follows a redirect from every other call, request with HEAD included", async () => {
    expect(await deliveryOf('get("/orders")')).toBe("followed");
    expect(await deliveryOf('request("HEAD", "/orders")')).toBe("followed");
  });
});

describe("a session built with a base URL", () => {
  async function pathUnder(base: string, path: string): Promise<unknown> {
    const units = await unitsIn(
      [
        "import aiohttp",
        "",
        "async def fetch_orders():",
        `    async with aiohttp.ClientSession(base_url="${base}") as session:`,
        `        return await session.get("${path}")`,
      ].join("\n"),
    );
    return boundary(units).path;
  }

  it("resolves a relative path against the base, as URL.join does", async () => {
    expect(await pathUnder("https://api.example.com/v1/", "orders")).toBe(
      "/v1/orders",
    );
    expect(await pathUnder("https://api.example.com/v1/", "/orders")).toBe(
      "/orders",
    );
    expect(await pathUnder("https://api.example.com", "/orders")).toBe(
      "/orders",
    );
  });

  it("reads the base passed first, without its keyword", async () => {
    const units = await unitsIn(
      [
        "import aiohttp",
        "",
        "async def fetch_orders():",
        '    session = aiohttp.ClientSession("https://api.example.com/v1/")',
        '    return await session.get("orders")',
      ].join("\n"),
    );
    expect(boundary(units).path).toBe("/v1/orders");
  });

  it("keeps the call's own path under a base aiohttp refuses for its missing trailing slash", async () => {
    expect(await pathUnder("https://api.example.com/v1", "orders")).toBe(
      "orders",
    );
  });
});

describe("the declaration's example", () => {
  it("makes the function it is written in a client", async () => {
    const units = await unitsIn(
      [
        "import aiohttp",
        "",
        "def example():",
        `    return ${AIOHTTP.declared.example}`,
      ].join("\n"),
    );

    expect(boundary(units)).toEqual({ method: "GET", path: "/orders" });
  });
});
