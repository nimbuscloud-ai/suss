import { describe, expect, it } from "vitest";

import { bindModule, discoverUnits, parsePython } from "@suss/adapter-python";

import { httpxClient } from "./index.js";

import type { RawCodeStructure } from "@suss/extractor";

async function unitsIn(source: string): Promise<RawCodeStructure[]> {
  const tree = await parsePython(source);
  const root = tree.rootNode;
  return discoverUnits(root, bindModule(root), {
    packs: [httpxClient()],
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

describe("a function that calls httpx", () => {
  it("is a client of the route the call names", async () => {
    const units = await unitsIn(
      [
        "import httpx",
        "",
        "def fetch_orders():",
        '    return httpx.get("https://api.example.com/orders")',
      ].join("\n"),
    );

    expect(units).toHaveLength(1);
    expect(boundary(units)).toEqual({ method: "GET", path: "/orders" });
  });

  it("reads a call on a client opened as a context manager", async () => {
    const units = await unitsIn(
      [
        "import httpx",
        "",
        "def fetch_order(order_id):",
        "    with httpx.Client() as client:",
        '        return client.get(f"/orders/{order_id}")',
      ].join("\n"),
    );

    expect(boundary(units)).toEqual({
      method: "GET",
      path: "/orders/{order_id}",
    });
  });

  it("reads a call on an async client the same way", async () => {
    const units = await unitsIn(
      [
        "import httpx",
        "",
        "async def create_order(body):",
        "    async with httpx.AsyncClient() as client:",
        '        return await client.post("/orders", json=body)',
      ].join("\n"),
    );

    expect(boundary(units)).toEqual({ method: "POST", path: "/orders" });
  });

  it("takes the method a request call states as an argument", async () => {
    const units = await unitsIn(
      [
        "import httpx",
        "",
        "def send(order_id):",
        '    return httpx.request("PATCH", f"/orders/{order_id}")',
      ].join("\n"),
    );

    expect(boundary(units).method).toBe("PATCH");
  });

  it("says nothing about a call on another library", async () => {
    const units = await unitsIn(
      [
        "import requests",
        "",
        "def fetch_orders():",
        '    return requests.get("/orders")',
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });
});
