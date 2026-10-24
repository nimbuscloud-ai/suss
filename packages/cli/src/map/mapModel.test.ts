import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkAll } from "@suss/checker";

import {
  calls,
  envRead,
  modelOf,
  opaque,
  resolver,
  rest,
  tableAccess,
  transition,
  unit,
} from "../__fixtures__/mapSummaries.js";
import { answerQuestion } from "../ask.js";
import { loadedSummaries } from "../loadedSummaries.js";
import { editorHref } from "./mapHtml.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { MapModel } from "./mapModel.js";

const store = unit({
  kind: "library",
  file: "src/orders/store.ts",
  name: "saveOrder",
  line: 20,
  transitions: [
    transition("saveOrder:return", {
      effects: [
        tableAccess("write", "orders", "db.orders.insert", 24),
        envRead("DATABASE_URL", true),
      ],
    }),
  ],
  gaps: [
    {
      type: "unfollowedCall",
      conditions: [],
      consequence: "unknown",
      description: "audit.log could not be followed",
      callee: "audit.log",
    },
  ],
});

const createOrder = unit({
  kind: "handler",
  file: "src/orders/routes.ts",
  name: "createOrder",
  line: 5,
  binding: rest("POST", "/orders"),
  transitions: [
    transition("createOrder:response:201", {
      status: 201,
      effects: [calls("saveOrder(body)", store)],
      line: 9,
    }),
    transition("createOrder:response:400", {
      status: 400,
      conditions: [opaque("!body.items")],
      line: 7,
    }),
  ],
});

const listOrders = unit({
  kind: "handler",
  file: "src/orders/routes.ts",
  name: "listOrders",
  line: 30,
  binding: rest("GET", "/orders"),
  transitions: [
    transition("listOrders:response:200", {
      status: 200,
      effects: [tableAccess("read", "orders", "db.orders.find")],
    }),
  ],
});

const placeOrder = unit({
  kind: "client",
  file: "web/checkout.ts",
  name: "placeOrder",
  binding: rest("POST", "/orders", "fetch"),
  transitions: [transition("placeOrder:return")],
});

const shop = [createOrder, listOrders, store, placeOrder];

function entry(model: MapModel, method: string, path: string) {
  const found = model.entries.find(
    (one) => one.method === method && one.path === path,
  );
  expect(found, `${method} ${path}`).toBeDefined();
  return found as NonNullable<typeof found>;
}

function boundaries(model: MapModel, at: ReturnType<typeof entry>) {
  return at.reach
    .map(
      (touch) =>
        `${touch.relations.join(",")} ${model.boundaries[touch.boundary]?.label}`,
    )
    .sort();
}

/** What `suss ask` lists for a unit, as relations and boundary. */
function askReaches(summaries: BehavioralSummary[], id: string): string[] {
  const out = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-map-ask-")),
    "answer.json",
  );
  const { answer } = answerQuestion({
    question: `what does ${id} reach`,
    loaded: loadedSummaries(summaries),
    json: true,
    output: out,
  });
  return (answer?.items as Array<{ boundary: string; relations: string[] }>)
    .map((item) => `${item.relations.join(",")} ${item.boundary}`)
    .sort();
}

describe("the map model", () => {
  it("lists each route once, with the statuses and conditions its summary records", () => {
    const model = modelOf(shop);

    const create = entry(model, "POST", "/orders");
    expect(model.entries).toHaveLength(2);
    expect(create.outcomes.map((o) => o.status).sort()).toEqual([201, 400]);
    expect(create.outcomes.find((o) => o.status === 400)?.conditions).toEqual([
      "!body.items",
    ]);
    expect(create.outcomes.find((o) => o.status === 400)?.line).toBe(7);
  });

  it("gives a route the same reach `suss ask` gives its handler", () => {
    const model = modelOf(shop);

    for (const handler of [createOrder, listOrders]) {
      const at = model.entries.find((one) =>
        one.units.some((u) => model.units[u]?.id === handler.identity.id),
      );
      expect(at).toBeDefined();
      expect(boundaries(model, at as NonNullable<typeof at>)).toEqual(
        askReaches(shop, handler.identity.id as string),
      );
    }
  });

  it("reaches a table through the service a route calls, with the call on the way and its line", () => {
    const model = modelOf(shop);

    const write = entry(model, "POST", "/orders").reach.find((touch) =>
      touch.relations.includes("writes"),
    );
    expect(model.boundaries[write?.boundary ?? -1]?.name).toBe("orders");
    expect(write?.through).toEqual(["saveOrder(body)"]);
    expect(write?.via).toBe("db.orders.insert");
    expect(write?.line).toBe(24);
  });

  it("marks a route whose reach crosses a call suss could not follow", () => {
    const model = modelOf(shop);

    expect(entry(model, "POST", "/orders").unfollowed).toHaveLength(1);
    expect(entry(model, "GET", "/orders").unfollowed).toHaveLength(0);
    expect(model.coverage.entriesAffected).toBe(1);
    expect(model.coverage.unfollowedCalls).toBe(1);
  });

  it("lists the caller check paired with a route", () => {
    const model = modelOf(shop);

    const callers = entry(model, "POST", "/orders").callers.map(
      (u) => model.units[u]?.name,
    );
    expect(callers).toEqual(["placeOrder"]);
    expect(model.check.pairs).toBe(checkAll(shop).pairs.length);
  });

  it("lists each table with what `ask` says writes and reads it", () => {
    const model = modelOf(shop);

    const orders = model.tables.find(
      (table) => model.boundaries[table.boundary]?.name === "orders",
    );
    expect(orders?.writers.map((t) => model.units[t.unit]?.name)).toEqual([
      "saveOrder",
    ]);
    expect(orders?.readers.map((t) => model.units[t.unit]?.name)).toEqual([
      "listOrders",
    ]);
  });

  it("records each read of a variable and whether it has a default", () => {
    const model = modelOf(shop);

    expect(
      model.envReads.map((read) => [
        model.boundaries[read.boundary]?.name,
        read.defaulted,
      ]),
    ).toEqual([["DATABASE_URL", true]]);
  });

  it("joins a spec with no id to the route the code serves, and keeps its statuses", () => {
    const declared = unit({
      kind: "handler",
      file: "openapi:api.yaml",
      name: "POST /orders",
      binding: rest("POST", "/orders", "openapi"),
      transitions: [
        transition("a", { status: 201 }),
        transition("b", { status: 409 }),
      ],
      noId: true,
    });

    const model = modelOf(shop, [declared]);

    const create = entry(model, "POST", "/orders");
    expect(create.specs).toHaveLength(1);
    expect(create.units).toHaveLength(1);
    expect(create.specStatuses).toEqual([201, 409]);
    expect(model.units[create.specs[0] as number]?.id).toBe(
      "openapi:api.yaml::POST /orders",
    );
  });

  it("gives every GraphQL field a type, from the code or else from the schema", () => {
    const approver = unit({
      kind: "resolver",
      file: "src/schema.ts",
      name: "Query.approver",
      binding: resolver("Query", "approver"),
      metadata: {
        graphql: {
          declaredContract: {
            returnType: { type: "ref", name: "Approver" },
            args: [{ name: "id", type: { type: "text" }, required: true }],
            provenance: "derived",
          },
        },
      },
    });
    const schema = unit({
      kind: "resolver",
      file: "schema.graphql:Query.approver",
      name: "Query.approver",
      binding: resolver("Query", "approver", "graphql"),
      noId: true,
      metadata: { sourceDocument: { label: "schema.graphql" } },
      definitions: {
        Approver: {
          type: "record",
          properties: {
            id: { type: "text" },
            manager: { type: "ref", name: "Approver" },
          },
        },
      },
    });

    const model = modelOf([approver], [schema]);

    const field = entry(model, "Query", "approver");
    expect(field.shape).toEqual({
      args: [{ name: "id", type: "string", required: true }],
      returns: "Approver",
      refs: ["Approver"],
    });
    const type = model.graphqlTypes.find((t) => t.name === "Approver");
    expect(type?.fields.map((f) => [f.name, f.shape.returns])).toEqual([
      ["id", "string"],
      ["manager", "Approver"],
    ]);
  });

  it("keeps two repositories' routes apart when both serve the same path from the same file", () => {
    const health = (name: string, commit: string) =>
      unit({
        kind: "handler",
        file: "src/index.ts",
        name: "handler",
        binding: rest("GET", "/health"),
        transitions: [transition("handler:response:200", { status: 200 })],
        repository: {
          name,
          path: "",
          remote: `git@github.com:acme/${name}.git`,
          commit,
        },
      });
    const billing = health("billing", "aaa111");
    const orders = health("orders", "bbb222");

    const model = modelOf([billing, orders]);
    // Neither read's root is on disk, so links go to each repository on GitHub.
    model.reads[0] = {
      ...(model.reads[0] as MapModel["reads"][number]),
      root: null,
    };

    const routes = model.entries.filter((one) => one.path === "/health");
    expect(routes).toHaveLength(2);
    const links = routes.map((one) =>
      editorHref(
        model.units[one.units[0] as number] as MapModel["units"][number],
        model,
        3,
      ),
    );
    expect(links.sort()).toEqual([
      "https://github.com/acme/billing/blob/aaa111/src/index.ts#L3",
      "https://github.com/acme/orders/blob/bbb222/src/index.ts#L3",
    ]);
    expect(model.repositories.map((r) => r.name).sort()).toEqual([
      "billing",
      "orders",
    ]);
  });

  it("links into a repository's subfolder when the extract ran below its top", () => {
    const route = unit({
      kind: "handler",
      file: "app/main.py",
      name: "read_items",
      binding: rest("GET", "/items", "fastapi"),
      repository: {
        name: "template",
        path: "backend",
        remote: "https://github.com/acme/template",
        commit: "ccc333",
      },
    });

    const model = modelOf([route]);
    model.reads[0] = {
      ...(model.reads[0] as MapModel["reads"][number]),
      root: null,
    };

    expect(
      editorHref(model.units[0] as MapModel["units"][number], model, 1),
    ).toBe(
      "https://github.com/acme/template/blob/ccc333/backend/app/main.py#L1",
    );
  });
});
