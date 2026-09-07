import { describe, expect, it } from "vitest";

import { bindModule, discoverUnits, parsePython } from "@suss/adapter-python";

import { aiohttpClient } from "./index.js";

import type { RawCodeStructure } from "@suss/extractor";

async function unitsIn(source: string): Promise<RawCodeStructure[]> {
  const tree = await parsePython(source);
  const root = tree.rootNode;
  return discoverUnits(root, bindModule(root), {
    packs: [aiohttpClient()],
    filePath: "app/orders.py",
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
