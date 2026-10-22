import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { restBinding, storageBinding } from "@suss/behavioral-ir";

import { matchEdges } from "./matcher.js";
import { SourceTree } from "./sourceTree.js";
import { SussSide } from "./sussSide.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { RouteEntry, Target, TracedEdge } from "./edges.js";

function unit(spec: {
  name: string;
  file: string;
  kind?: BehavioralSummary["kind"];
  route?: { method: string; path: string };
  effects?: Effect[];
}): BehavioralSummary {
  return {
    kind: spec.kind ?? (spec.route === undefined ? "library" : "handler"),
    location: {
      file: spec.file,
      range: { start: 1, end: 10 },
      exportName: spec.name,
    },
    identity: {
      name: spec.name,
      exportPath: [spec.name],
      boundaryBinding:
        spec.route === undefined
          ? null
          : restBinding({
              transport: "http",
              method: spec.route.method,
              path: spec.route.path,
              recognition: "express",
            }),
      id: `app::${spec.file}::${spec.name}`,
    },
    inputs: [],
    transitions: [
      {
        id: `${spec.name}:default`,
        conditions: [],
        output: { type: "return", value: null },
        effects: spec.effects ?? [],
        location: { start: 1, end: 10 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  } as BehavioralSummary;
}

function reads(container: string | null): Effect {
  return {
    type: "interaction",
    binding: storageBinding({
      recognition: "test",
      storageSystem: "postgresql",
      scope: "default",
      container,
    }),
    callee: "db.query",
    interaction: { class: "storage-access", kind: "read", fields: ["*"] },
  } as Effect;
}

function calls(name: string, file: string): Effect {
  return {
    type: "invocation",
    callee: name,
    summary: `app::${file}::${name}`,
    args: [],
    async: true,
  };
}

const SUMMARIES: BehavioralSummary[] = [
  unit({
    name: "getUser",
    file: "src/users.ts",
    route: { method: "GET", path: "/users/:id" },
    effects: [calls("findUser", "src/db.ts")],
  }),
  unit({ name: "findUser", file: "src/db.ts", effects: [reads("User")] }),
  unit({
    name: "writeAudit",
    file: "src/audit.ts",
    effects: [reads("audit_log")],
  }),
  unit({
    name: "createOrder",
    file: "src/orders.ts",
    route: { method: "POST", path: "/orders" },
    effects: [reads(null)],
  }),
  unit({
    name: "listReports",
    file: "src/reports.ts",
    route: { method: "GET", path: "/reports" },
  }),
];

function entry(method: string, route: string): RouteEntry {
  return { method, route, examplePath: null, code: {} };
}

function edge(from: RouteEntry, target: Target, rendered = false): TracedEdge {
  return {
    entry: from,
    target,
    count: 1,
    duringRender: rendered ? 1 : 0,
    templates: rendered ? ["views/reports.html.erb"] : [],
    evidence: [{ traceId: "t", spanId: "s", scope: "test", attributes: {} }],
  };
}

const table = (name: string, system = "postgresql"): Target => ({
  kind: "storage",
  system,
  table: name,
});

let dir = "";
let side: SussSide;
let tree: SourceTree;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-oracle-"));
  fs.mkdirSync(path.join(dir, "summaries"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "summaries", "app.json"),
    JSON.stringify(SUMMARIES),
  );
  fs.writeFileSync(
    path.join(dir, "src", "users.ts"),
    "export const getUser = () => findUser();\n",
  );
  side = new SussSide(path.join(dir, "summaries"));
  tree = new SourceTree(path.join(dir, "src"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("matchEdges", () => {
  const getUser = entry("GET", "/users/{id}");
  const edges = [
    edge(getUser, table("users")),
    edge(getUser, table("audit_log")),
    edge(getUser, table("users", "mysql")),
    edge(entry("POST", "/orders"), table("orders")),
    edge(entry("GET", "/missing"), table("users")),
    edge(entry("GET", "/reports"), table("invoices")),
    edge(entry("GET", "/reports"), table("sessions"), true),
  ];

  function verdicts() {
    const routes = [...new Set(edges.map((one) => one.entry))].map((one) => ({
      entry: one,
      requests: 1,
    }));
    return matchEdges(side, edges, routes, tree).verdicts;
  }

  it("finds a table one call away, and says the model and table agreed by name", () => {
    const found = verdicts().find(
      (one) => one.edge === "GET /users/{id} -> postgresql:users",
    );

    expect(found).toMatchObject({
      found: true,
      agreement: "byName",
      via: { label: "postgresql:User", through: ["findUser"] },
    });
  });

  it("gives each miss the first reason that fits", () => {
    const reasons = Object.fromEntries(
      verdicts()
        .filter((one) => !one.found)
        .map((one) => [one.edge, one.otherKind ?? one.reason]),
    );

    expect(reasons).toEqual({
      "GET /users/{id} -> postgresql:audit_log": "wrapperOrFactory",
      "GET /users/{id} -> mysql:users": "noPack",
      "POST /orders -> postgresql:orders": "nameNotSettled",
      "GET /missing -> postgresql:users": "routeNotDiscovered",
      "GET /reports -> postgresql:invoices": "untouched",
      "GET /reports -> postgresql:sessions": "template",
    });
  });
});
