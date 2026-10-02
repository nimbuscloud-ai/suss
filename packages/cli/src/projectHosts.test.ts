import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { restBinding } from "@suss/behavioral-ir";

import { forgetOwnHosts, projectHosts } from "./projectHosts.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function client(host: string | undefined): BehavioralSummary {
  return {
    kind: "client",
    location: {
      file: "src/orders.ts",
      range: { start: 1, end: 4 },
      exportName: "loadOrders",
    },
    identity: {
      name: "loadOrders",
      exportPath: ["loadOrders"],
      boundaryBinding: restBinding({
        transport: "http",
        method: "GET",
        path: "/orders",
        recognition: "fetch",
        host,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function hostOf(summary: BehavioralSummary): string | undefined {
  const semantics = summary.identity.boundaryBinding?.semantics;
  return semantics?.name === "rest" ? semantics.host : undefined;
}

describe("the hosts suss.json says the project serves", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function projectWith(file: unknown): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-hosts-"));
    fs.writeFileSync(path.join(dir, "suss.json"), JSON.stringify(file));
    const nested = path.join(dir, "web");
    fs.mkdirSync(nested);
    return nested;
  }

  it("reads the nearest suss.json above the project, lowercased", () => {
    const start = projectWith({
      version: 1,
      read: [],
      hosts: ["API.Example.com"],
    });
    expect([...projectHosts(start)]).toEqual(["api.example.com"]);
  });

  it("refuses a list that is not host names", () => {
    const start = projectWith({ version: 1, read: [], hosts: "x" });
    expect(() => projectHosts(start)).toThrow(/"hosts" has to be a list/);
  });

  it("leaves the host off a call to a host the project serves", () => {
    const hosts = new Set(["api.example.com"]);
    const own = client("api.example.com:8443");
    const other = client("maps.example.org");
    const relative = client(undefined);
    for (const summary of [own, other, relative]) {
      forgetOwnHosts(summary, hosts);
    }
    expect([hostOf(own), hostOf(other), hostOf(relative)]).toEqual([
      undefined,
      "maps.example.org",
      undefined,
    ]);
  });
});
