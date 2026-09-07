import { describe, expect, it } from "vitest";

import { bindModule, discoverUnits, parsePython } from "@suss/adapter-python";

import { requestsClient } from "./index.js";

import type { RawCodeStructure } from "@suss/extractor";

async function unitsIn(source: string): Promise<RawCodeStructure[]> {
  const tree = await parsePython(source);
  const root = tree.rootNode;
  return discoverUnits(root, bindModule(root), {
    packs: [requestsClient()],
    filePath: "app/orders.py",
  });
}

/** The REST boundary of the one unit discovered, for the common case. */
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

describe("a function that calls requests", () => {
  it("is a client of the route the call names", async () => {
    const units = await unitsIn(
      [
        "import requests",
        "",
        "def fetch_orders():",
        '    return requests.get("https://api.example.com/orders").json()',
      ].join("\n"),
    );

    expect(units).toHaveLength(1);
    expect(units[0]?.identity.kind).toBe("client");
    expect(units[0]?.identity.name).toBe("fetch_orders");
    // The host is not part of what a route declares, so the shared
    // reader keeps the path alone.
    expect(boundary(units)).toEqual({ method: "GET", path: "/orders" });
  });

  it("reads the method off whichever function the call names", async () => {
    const units = await unitsIn(
      [
        "import requests",
        "",
        "def create_order(body):",
        '    return requests.post("/orders", json=body)',
      ].join("\n"),
    );

    expect(boundary(units)).toEqual({ method: "POST", path: "/orders" });
  });

  it("reads a function imported from the package by its own name", async () => {
    const units = await unitsIn(
      [
        "from requests import delete",
        "",
        "def drop_order(order_id):",
        '    return delete("/orders/" + order_id)',
      ].join("\n"),
    );

    expect(boundary(units).method).toBe("DELETE");
  });

  it("takes the method a request call states as an argument", async () => {
    const units = await unitsIn(
      [
        "import requests",
        "",
        "def send(order_id):",
        '    return requests.request("PATCH", f"/orders/{order_id}")',
      ].join("\n"),
    );

    expect(boundary(units).method).toBe("PATCH");
  });

  it("reads a call on a session the package built", async () => {
    const units = await unitsIn(
      [
        "import requests",
        "",
        "session = requests.Session()",
        "",
        "def fetch_order(order_id):",
        '    return session.get(f"/orders/{order_id}")',
      ].join("\n"),
    );

    expect(boundary(units).method).toBe("GET");
  });

  it("says nothing about a call on something else entirely", async () => {
    const units = await unitsIn(
      [
        "import httpx",
        "",
        "def fetch_orders():",
        '    return httpx.get("/orders")',
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("leaves a call written at module level alone", async () => {
    const units = await unitsIn(
      ["import requests", "", 'health = requests.get("/health")'].join("\n"),
    );

    expect(units).toEqual([]);
  });

  it("says nothing about a URL that does not settle on a string", async () => {
    const units = await unitsIn(
      [
        "import requests",
        "",
        "def fetch(target):",
        "    return requests.get(target)",
      ].join("\n"),
    );

    expect(units).toEqual([]);
  });
});
