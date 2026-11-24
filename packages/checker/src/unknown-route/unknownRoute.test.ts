import { describe, expect, it } from "vitest";

import {
  restBinding,
  runtimeConfigBinding,
  withHttpMetadata,
  withServedBesideMetadata,
} from "@suss/behavioral-ir";

import { checkAll } from "../index.js";

import type { BehavioralSummary, ServedBesideEntry } from "@suss/behavioral-ir";

function route(
  method: string,
  path: string,
  opts: { workspace?: string; pack?: string; file?: string } = {},
): BehavioralSummary {
  const name = `${method} ${path}`;
  return {
    kind: "handler",
    location: {
      file: opts.file ?? `app${path}/route.ts`,
      range: { start: 1, end: 10 },
      exportName: method,
      workspace: opts.workspace ?? "shop",
    },
    identity: {
      name,
      exportPath: [method],
      boundaryBinding: restBinding({
        transport: "http",
        recognition: opts.pack ?? "nextjs",
        method,
        path,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function client(
  name: string,
  method: string,
  path: string,
  opts: { workspace?: string; host?: string; file?: string } = {},
): BehavioralSummary {
  return {
    kind: "client",
    location: {
      file: opts.file ?? `src/${name}.ts`,
      range: { start: 2, end: 6 },
      exportName: name,
      workspace: opts.workspace ?? "shop",
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: restBinding({
        transport: "http",
        recognition: "fetch",
        method,
        path,
        ...(opts.host === undefined ? {} : { host: opts.host }),
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

/**
 * What a framework pack states it read beside its routes. A test lists
 * it beside the routes, and `stated` writes it on each route of that
 * pack in that workspace, the way an adapter does.
 */
function statement(
  pack: string,
  entries: ServedBesideEntry[] = [],
  workspace = "shop",
): BehavioralSummary {
  return {
    kind: "module-init",
    location: {
      file: "next.config.js",
      range: { start: 1, end: 1 },
      exportName: null,
      workspace,
    },
    identity: { name: pack, exportPath: null, boundaryBinding: null },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: { statedEntries: entries },
  };
}

function stated(summaries: BehavioralSummary[]): BehavioralSummary[] {
  const statements = summaries.filter((s) => s.metadata?.statedEntries);
  return summaries
    .filter((s) => s.metadata?.statedEntries === undefined)
    .map((summary) => {
      const found = statements.find(
        (one) =>
          one.identity.name === summary.identity.boundaryBinding?.recognition &&
          one.location.workspace === summary.location.workspace &&
          summary.kind === "handler",
      );
      return found === undefined
        ? summary
        : {
            ...summary,
            metadata: withServedBesideMetadata(summary.metadata, {
              pack: found.identity.name,
              entries: found.metadata?.statedEntries as ServedBesideEntry[],
            }),
          };
    });
}

const checked = (summaries: BehavioralSummary[]) => checkAll(stated(summaries));

function beside(
  by: ServedBesideEntry["by"],
  requests: { path?: string; pattern?: string; methods?: string[] },
): ServedBesideEntry {
  return { by, ...requests, file: "next.config.js", line: 3 };
}

const renamedShop = (): BehavioralSummary[] => [
  route("GET", "/api/orders/{id}/totals"),
  route("GET", "/api/orders/{id}"),
  statement("nextjs"),
];

const findingsOf = (summaries: BehavioralSummary[]) =>
  checked(summaries).findings.filter(
    (f) => f.kind === "restMethodOnUnknownPath",
  );

describe("a call to a route its service does not serve", () => {
  it("is reported once, with the route it was likely renamed to", () => {
    const findings = findingsOf([
      ...renamedShop(),
      client("loadSummary", "GET", "/api/orders/{id}/summary"),
    ]);

    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding?.severity).toBe("error");
    expect(finding?.description).toBe(
      "loadSummary calls GET /api/orders/{id}/summary, and shop, the service it calls, does not serve that path. Every call gets a 404. Routes nearby: GET /api/orders/{id}/totals.",
    );
    expect(finding?.target).toEqual({
      service: "shop",
      routes: 2,
      nearby: ["GET /api/orders/{id}/totals"],
    });
    expect(finding?.consumer.summary).toBe("src/loadSummary.ts::loadSummary");
  });

  it("lists first the route a rename most likely left, with the call's method and a segment that starts the same", () => {
    const findings = findingsOf([
      route("GET", "/api/admin/analytics"),
      route("POST", "/api/admin/ban"),
      route("GET", "/api/admin/impersonations"),
      route("POST", "/api/admin/impersonate-user"),
      statement("nextjs"),
      client("impersonate", "POST", "/api/admin/impersonate"),
    ]);

    expect(findings[0]?.target?.nearby).toEqual([
      "POST /api/admin/impersonate-user",
      "POST /api/admin/ban",
      "GET /api/admin/impersonations",
      "GET /api/admin/analytics",
    ]);
  });

  it("says which methods the path serves when only the method is wrong", () => {
    const findings = findingsOf([
      route("POST", "/api/orders"),
      statement("nextjs"),
      client("listOrders", "GET", "/api/orders"),
    ]);

    expect(findings.map((f) => f.description)).toEqual([
      "listOrders calls GET /api/orders, and shop, the service it calls, serves that path only for POST. Every GET to it fails. Routes nearby: POST /api/orders.",
    ]);
  });

  it("is not reported when the service's pack states nothing about what else serves requests", () => {
    const findings = findingsOf([
      route("GET", "/api/orders/{id}/totals"),
      client("loadSummary", "GET", "/api/orders/{id}/summary"),
    ]);

    expect(findings).toEqual([]);
  });

  it("is not reported when one route's pack states nothing, though another's does", () => {
    const findings = findingsOf([
      ...renamedShop(),
      route("GET", "/health", { pack: "express", file: "server.ts" }),
      client("loadSummary", "GET", "/api/orders/{id}/summary"),
    ]);

    expect(findings).toEqual([]);
  });

  it("is not reported when a rewrite covers the path", () => {
    const findings = findingsOf([
      route("GET", "/api/orders/{id}/totals"),
      statement("nextjs", [beside("rewrite", { path: "/api/{path*}" })]),
      client("loadSummary", "GET", "/api/orders/{id}/summary"),
    ]);

    expect(findings).toEqual([]);
  });

  it("reads a matcher that leaves the path out, and one that takes it in", () => {
    const leavesApiOut = findingsOf([
      route("GET", "/api/orders/{id}/totals"),
      statement("nextjs", [
        beside("middleware", { pattern: "^/((?!api/|_next/).*)$" }),
      ]),
      client("loadSummary", "GET", "/api/orders/{id}/summary"),
    ]);
    const takesApiIn = findingsOf([
      route("GET", "/api/orders/{id}/totals"),
      statement("nextjs", [beside("middleware", { pattern: "^/api/.*$" })]),
      client("loadSummary", "GET", "/api/orders/{id}/summary"),
    ]);

    expect(leavesApiOut).toHaveLength(1);
    expect(takesApiIn).toEqual([]);
  });

  it("fills a hole in the call with a word the matcher spells", () => {
    const findings = findingsOf([
      route("GET", "/api/orders/{id}/totals"),
      statement("nextjs", [beside("middleware", { pattern: "^/admin/.*$" })]),
      client("loadSection", "GET", "/{section}/orders"),
    ]);

    expect(findings).toEqual([]);
  });

  it("is not reported when what the pack could not read may serve any path", () => {
    const findings = findingsOf([
      route("GET", "/api/orders/{id}/totals"),
      statement("nextjs", [beside("unread", {})]),
      client("loadSummary", "GET", "/api/orders/{id}/summary"),
    ]);

    expect(findings).toEqual([]);
  });

  it("is not reported for a GET a static file or a page can serve", () => {
    const summaries = [
      route("GET", "/api/orders"),
      statement("nextjs", [
        beside("static", { path: "/ring.mp3", methods: ["GET"] }),
        beside("page", { path: "/orders/{id}", methods: ["GET"] }),
      ]),
    ];

    expect(
      findingsOf([...summaries, client("playRing", "GET", "/ring.mp3")]),
    ).toEqual([]);
    expect(
      findingsOf([...summaries, client("openOrder", "GET", "/orders/{id}")]),
    ).toEqual([]);
    expect(
      findingsOf([...summaries, client("postOrder", "POST", "/orders/{id}")]),
    ).toHaveLength(1);
  });

  it("is not reported when the service has a catch-all route", () => {
    const findings = findingsOf([
      ...renamedShop(),
      route("GET", "/{rest*}", { file: "app/[...rest]/route.ts" }),
      client("loadSummary", "POST", "/api/orders/{id}/summary"),
    ]);

    expect(findings).toEqual([]);
  });

  it("is not reported when a route of the service has no path suss read", () => {
    const unread = route("GET", "/unused", { file: "app/x/route.ts" });
    unread.identity.boundaryBinding = restBinding({
      transport: "http",
      recognition: "nextjs",
      method: "GET",
      path: null,
    });
    const findings = findingsOf([
      ...renamedShop(),
      unread,
      client("loadSummary", "GET", "/api/orders/{id}/summary"),
    ]);

    expect(findings).toEqual([]);
  });

  it("is not reported for a path with a piece suss did not read in full", () => {
    for (const path of [
      "/api/orders/{id}.json",
      "/api/orders/export{query}",
      "{API_URL}/api/orders/{id}/summary",
      "/api/(orders|carts)/{id}/summary",
      "/api/orders/{rest*}",
    ]) {
      expect(
        findingsOf([...renamedShop(), client("loadSummary", "GET", path)]),
      ).toEqual([]);
    }
  });

  it("is not reported when a route with the call's method may take a hole in the call", () => {
    // A segment the code picks at run time comes out as a hole, and the
    // route that spells it out may be the one the call reaches.
    const findings = findingsOf([
      route("DELETE", "/api/teams/{id}/invites"),
      route("DELETE", "/api/teams/{id}/members"),
      statement("nextjs"),
      client("removeMember", "DELETE", "/api/teams/{teamId}/{value}"),
    ]);

    expect(findings).toEqual([]);
  });

  it("is not reported when the URL took a default over a value suss could not read", () => {
    const call = client("createTeam", "POST", "/teams");
    call.metadata = withHttpMetadata(undefined, { urlTookDefault: true });

    expect(findingsOf([...renamedShop(), call])).toEqual([]);
  });

  it("is not reported for a helper whose caller passes the method", () => {
    const helper = client("send", "GET", "/api/orders/{id}/summary");
    helper.bindingFrom = {
      method: [{ type: "input", inputRef: "method", path: [] }],
    };

    expect(findingsOf([...renamedShop(), helper])).toEqual([]);
  });
});

describe("a call whose service suss cannot settle", () => {
  it("is listed as unchecked when the code making it serves no routes", () => {
    const result = checked([
      ...renamedShop(),
      client("loadSummary", "GET", "/api/orders/{id}/summary", {
        workspace: "storefront",
      }),
    ]);

    expect(result.findings.map((f) => f.kind)).not.toContain(
      "restMethodOnUnknownPath",
    );
    expect(result.unchecked.routes).toEqual([
      {
        consumer: "src/loadSummary.ts::loadSummary",
        name: "loadSummary",
        call: "GET /api/orders/{id}/summary",
        reason:
          "the code that makes the call serves no routes, so whatever is in front of it, such as a proxy or a gateway, decides where the call goes",
      },
    ]);
  });

  it("is listed as unchecked when it names a host that may be one of the run's services", () => {
    const result = checked([
      ...renamedShop(),
      client("loadSummary", "GET", "/api/orders/{id}/summary", {
        host: "localhost:4000",
      }),
    ]);

    expect(result.unchecked.routes.map((u) => u.reason)).toEqual([
      "the call names the host localhost:4000, which may be a service in this run, and nothing says which one",
    ]);
    expect(
      result.findings.filter((f) => f.kind === "restMethodOnUnknownPath"),
    ).toEqual([]);
  });

  it("is left out when it goes to another company's API", () => {
    const result = checked([
      ...renamedShop(),
      client("charge", "POST", "/v1/charges", { host: "api.payments.com" }),
    ]);

    expect(result.unchecked.routes).toEqual([]);
    expect(
      result.findings.filter((f) => f.kind === "restMethodOnUnknownPath"),
    ).toEqual([]);
  });
});

describe("a call whose base URL the deployment fills in", () => {
  /** What the deployment sets for the code under `web`. */
  function runtime(values: Record<string, string>): BehavioralSummary {
    return {
      kind: "library",
      location: {
        file: "wrangler.toml",
        range: { start: 1, end: 5 },
        exportName: null,
      },
      identity: {
        name: "storefront",
        exportPath: null,
        boundaryBinding: runtimeConfigBinding({
          recognition: "wrangler",
          deploymentTarget: "worker",
          instanceName: "storefront",
        }),
        deployableUnit: {
          deploymentTarget: "worker" as const,
          instanceName: "storefront",
        },
      },
      inputs: [],
      transitions: [],
      gaps: [],
      confidence: { source: "declared", level: "high" },
      metadata: {
        runtimeContract: {
          envVars: Object.keys(values),
          envVarValues: values,
        },
        codeScope: { kind: "codeUri" as const, path: "web" },
      },
    };
  }

  const backend = (): BehavioralSummary[] => [
    route("GET", "/orders/{id}/totals", {
      workspace: "orders-api",
      pack: "express",
      file: "server.ts",
    }),
    statement("express", [], "orders-api"),
  ];

  it("goes to the one service that serves routes under the base's path", () => {
    const findings = findingsOf([
      ...backend(),
      client("loadSummary", "GET", "{API_URL}/orders/{id}/summary", {
        workspace: "storefront",
        file: "web/summary.ts",
      }),
      runtime({ API_URL: "http://localhost:4000" }),
    ]);

    expect(findings.map((f) => f.description)).toEqual([
      "loadSummary calls GET /orders/{id}/summary, and orders-api, the service it calls, does not serve that path. Every call gets a 404. Routes nearby: GET /orders/{id}/totals.",
    ]);
  });

  it("is listed as unchecked when two services serve routes under it", () => {
    const result = checked([
      ...backend(),
      route("GET", "/health", {
        workspace: "billing",
        pack: "express",
        file: "billing.ts",
      }),
      statement("express", [], "billing"),
      client("loadSummary", "GET", "{API_URL}/orders/{id}/summary", {
        workspace: "storefront",
        file: "web/summary.ts",
      }),
      runtime({ API_URL: "http://localhost:4000" }),
    ]);

    expect(result.unchecked.routes.map((u) => u.reason)).toEqual([
      "2 services in this run serve routes under /, where the deployment's base URL points, and nothing says which one the call reaches",
    ]);
  });
});
