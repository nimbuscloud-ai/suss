import { describe, expect, it } from "vitest";

import {
  bindModule,
  discoverUnits,
  factsForFile,
  parsePython,
} from "@suss/adapter-python";

import { aiohttpClient } from "./index.js";

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
