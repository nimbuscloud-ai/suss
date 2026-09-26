import { describe, expect, it } from "vitest";

import { restBinding, storageBinding } from "@suss/behavioral-ir";

import { provider, response, transition } from "../__fixtures__/pairs.js";
import { changedBoundaries, findingsSince } from "./changesSince.js";

import type {
  BehavioralSummary,
  Effect,
  Finding,
  Transition,
} from "@suss/behavioral-ir";

function route(
  name: string,
  path: string,
  transitions: Transition[],
): BehavioralSummary {
  const summary = provider(name, transitions);
  return {
    ...summary,
    identity: {
      ...summary.identity,
      boundaryBinding: restBinding({
        transport: "http",
        recognition: "express",
        method: "POST",
        path,
      }),
    },
  };
}

function writesOrders(): Effect {
  return {
    type: "interaction",
    binding: storageBinding({
      recognition: "prisma",
      storageSystem: "postgresql",
      scope: "default",
      container: "orders",
    }),
    interaction: { class: "storage-access", kind: "write", fields: ["sku"] },
  };
}

const created = transition("post:response:201:aaaaaaa", {
  output: response(201),
});
const rejected = transition("post:response:400:bbbbbbb", {
  output: response(400),
});
const duplicate = transition("post:response:409:ccccccc", {
  output: response(409),
});

function finding(description: string): Finding {
  return {
    kind: "unhandledProviderCase",
    boundary: restBinding({
      transport: "http",
      recognition: "express",
      method: "POST",
      path: "/orders",
    }),
    provider: {
      summary: "src/handlers/post.ts::post",
      location: {
        file: "src/handlers/post.ts",
        range: { start: 1, end: 9 },
        exportName: "post",
      },
    },
    consumer: {
      summary: "web/submit.ts::submit",
      location: {
        file: "web/submit.ts",
        range: { start: 1, end: 9 },
        exportName: "submit",
      },
    },
    description,
    severity: "warning",
  };
}

describe("findingsSince", () => {
  it("splits the findings into new and gone, by identity", () => {
    const kept = finding("Provider produces status 404 but nothing handles it");
    const gone = finding("Provider produces status 400 but nothing handles it");
    const added = finding(
      "Provider produces status 409 but nothing handles it",
    );

    const since = findingsSince([kept, gone], [kept, added]);

    expect(since.added).toEqual([added]);
    expect(since.resolved).toEqual([gone]);
  });

  it("sees a finding whose unit moved down the file as the one it was", () => {
    const before = finding(
      "Provider produces status 409 but nothing handles it",
    );
    const after: Finding = {
      ...before,
      provider: {
        ...before.provider,
        location: {
          ...before.provider.location,
          range: { start: 30, end: 38 },
        },
      },
    };

    const since = findingsSince([before], [after]);

    expect(since.added).toEqual([]);
    expect(since.resolved).toEqual([]);
  });
});

describe("changedBoundaries", () => {
  it("names nothing when every unit behaves the same", () => {
    const before = [route("post", "/orders", [created, rejected])];
    const after = [route("post", "/orders", [created, rejected])];

    expect(changedBoundaries(before, after)).toEqual([]);
  });

  it("names the route of a handler that gained an outcome", () => {
    const before = [route("post", "/orders", [created, rejected])];
    const after = [route("post", "/orders", [created, rejected, duplicate])];

    expect(changedBoundaries(before, after)).toEqual([
      { key: "POST /orders", units: ["src/handlers/post.ts::post"] },
    ]);
  });

  it("leaves out a handler whose lines moved and whose behavior did not", () => {
    const movedDown = (t: Transition): Transition => ({
      ...t,
      location: { start: t.location.start + 20, end: t.location.end + 20 },
    });
    const before = [route("post", "/orders", [created, rejected])];
    const after = [
      route("post", "/orders", [movedDown(created), movedDown(rejected)]),
    ];

    expect(changedBoundaries(before, after)).toEqual([]);
  });

  it("names a store the changed path now writes, beside the route", () => {
    const writing: Transition = { ...created, effects: [writesOrders()] };
    const before = [route("post", "/orders", [created])];
    const after = [route("post", "/orders", [writing])];

    expect(changedBoundaries(before, after).map((b) => b.key)).toEqual([
      "POST /orders",
      "postgresql:orders",
    ]);
  });

  it("names the store an unchanged path writes only when that path moved", () => {
    const writing: Transition = { ...created, effects: [writesOrders()] };
    const before = [route("post", "/orders", [writing])];
    const after = [route("post", "/orders", [writing, duplicate])];

    expect(changedBoundaries(before, after).map((b) => b.key)).toEqual([
      "POST /orders",
    ]);
  });

  it("names the routes of units that appeared or went away", () => {
    const before = [route("post", "/orders", [created])];
    const after = [route("cancel", "/orders/:id/cancel", [created])];

    expect(changedBoundaries(before, after).map((b) => b.key)).toEqual([
      "POST /orders",
      "POST /orders/{id}/cancel",
    ]);
  });

  it("names both routes when a handler moved to another path", () => {
    const before = [route("post", "/orders", [created])];
    const after = [route("post", "/purchases", [created])];

    expect(changedBoundaries(before, after).map((b) => b.key)).toEqual([
      "POST /orders",
      "POST /purchases",
    ]);
  });
});
