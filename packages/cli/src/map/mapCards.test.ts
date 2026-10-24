import { describe, expect, it } from "vitest";

import {
  modelOf,
  opaque,
  resolver,
  rest,
  tableAccess,
  transition,
  unit,
} from "../__fixtures__/mapSummaries.js";
import { CARD_ORDER, CARD_RULES, pickCards } from "./mapCards.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CardKind } from "./mapCards.js";
import type { MapModel } from "./mapModel.js";

function route(
  method: string,
  path: string,
  options: {
    writes?: string[];
    status?: number;
    wrapper?: string;
    unread?: boolean;
  } = {},
): BehavioralSummary {
  const name = `${method.toLowerCase()}${path.replace(/\W/g, "_")}`;
  return unit({
    kind: "handler",
    file: "src/routes.ts",
    name,
    line: 10,
    binding: rest(method, path),
    transitions: [
      transition(`${name}:response:200`, {
        status: 200,
        effects: (options.writes ?? []).map((table) =>
          tableAccess("write", table, `${table}.insert`),
        ),
      }),
      ...(options.wrapper === undefined
        ? []
        : [
            transition(`${options.wrapper}:response:${options.status}`, {
              status: options.status ?? 302,
              conditions: [opaque("!user")],
              wrapper: options.wrapper,
            }),
          ]),
    ],
    gaps: options.unread
      ? [
          {
            type: "unreadOutcome",
            conditions: [],
            consequence: "unknown",
            description: "no pack read this",
          },
        ]
      : [],
  });
}

function kinds(model: MapModel): CardKind[] {
  return pickCards(model).map((card) => card.kind);
}

describe("the cards", () => {
  it("each have a name, a rule, and a place in the order or at the end", () => {
    for (const [kind, rule] of Object.entries(CARD_RULES)) {
      expect(rule.name.length, kind).toBeGreaterThan(0);
      expect(rule.rule.length, kind).toBeGreaterThan(0);
      expect(
        CARD_ORDER.includes(kind as CardKind) || kind === "notRead",
        kind,
      ).toBe(true);
    }
  });

  it("show a finding only when check placed it on a route with both sides read", () => {
    const model = modelOf([route("GET", "/a")]);
    const finding = {
      kind: "unhandledProviderCase" as const,
      severity: "warning" as const,
      description:
        "Provider produces status 404 but no consumer branch handles it",
      entry: 0,
      provider: { unit: 0, line: 12 },
      consumer: { unit: 0, line: 3 },
    };

    model.findings = [{ ...finding, consumer: { unit: null, line: null } }];
    expect(CARD_RULES.finding.pick(model)).toEqual([]);

    model.findings = [finding];
    expect(CARD_RULES.finding.pick(model)).toEqual([
      { kind: "finding", entries: [0], total: 1, finding: 0 },
    ]);
  });

  it("name the route that writes the most tables once it writes three", () => {
    const two = modelOf([route("POST", "/a", { writes: ["x", "y"] })]);
    expect(CARD_RULES.mostTablesWritten.pick(two)).toEqual([]);

    const three = modelOf([
      route("POST", "/a", { writes: ["x", "y"] }),
      route("POST", "/b", { writes: ["x", "y", "z"] }),
    ]);
    const [card] = CARD_RULES.mostTablesWritten.pick(three);
    expect(card?.total).toBe(3);
    expect(three.entries[card?.entries[0] ?? -1]?.path).toBe("/b");
  });

  it("count GET routes whose reach writes a table, and no other method", () => {
    const model = modelOf([
      route("GET", "/a", { writes: ["visits"] }),
      route("GET", "/b"),
      route("POST", "/c", { writes: ["visits"] }),
    ]);

    const [card] = CARD_RULES.getWrites.pick(model);
    expect(card?.total).toBe(1);
    expect(model.entries[card?.entries[0] ?? -1]?.path).toBe("/a");
    expect(CARD_RULES.getWrites.pick(modelOf([route("GET", "/b")]))).toEqual(
      [],
    );
  });

  it("name the table five or more routes write, with each place that writes it", () => {
    const four = modelOf(
      ["/a", "/b", "/c", "/d"].map((p) =>
        route("POST", p, { writes: ["audit"] }),
      ),
    );
    expect(CARD_RULES.mostWrittenTable.pick(four)).toEqual([]);

    const five = modelOf(
      ["/a", "/b", "/c", "/d", "/e"].map((p) =>
        route("POST", p, { writes: ["audit"] }),
      ),
    );
    const [card] = CARD_RULES.mostWrittenTable.pick(five);
    expect(card?.total).toBe(5);
    expect(five.boundaries[card?.boundary ?? -1]?.name).toBe("audit");
    expect(card?.places).toHaveLength(5);
  });

  it("group an outcome a middleware adds once three routes share it", () => {
    const shared = modelOf(
      ["/a", "/b", "/c"].map((p) =>
        route("GET", p, { wrapper: "requireUser", status: 302 }),
      ),
    );

    const [card] = CARD_RULES.sharedEarlyReturn.pick(shared);
    expect(card?.total).toBe(3);
    expect(card?.outcome).toEqual({
      wrapper: "requireUser",
      status: 302,
      condition: "!user",
    });
    expect(
      CARD_RULES.sharedEarlyReturn.pick(
        modelOf(
          ["/a", "/b"].map((p) => route("GET", p, { wrapper: "requireUser" })),
        ),
      ),
    ).toEqual([]);
  });

  it("list the fields with no caller here only when another field has one", () => {
    const field = (name: string) =>
      unit({
        kind: "resolver",
        file: "src/schema.ts",
        name: `Query.${name}`,
        binding: resolver("Query", name),
      });
    const model = modelOf([field("orders"), field("order")]);
    expect(CARD_RULES.uncalledFields.pick(model)).toEqual([]);

    (model.entries[0] as MapModel["entries"][number]).callers = [0];
    const [card] = CARD_RULES.uncalledFields.pick(model);
    expect(card?.total).toBe(1);
    expect(model.entries[card?.entries[0] ?? -1]?.path).toBe("order");
  });

  it("say most entry points were not read, and put that card last", () => {
    const model = modelOf([
      route("POST", "/a", { writes: ["x", "y", "z"], unread: true }),
      route("GET", "/b", { writes: ["x"], unread: true }),
      route("GET", "/c"),
    ]);

    expect(kinds(model)).toEqual(["mostTablesWritten", "getWrites", "notRead"]);
    expect(
      CARD_RULES.notRead.pick(
        modelOf([
          route("GET", "/a", { unread: true }),
          route("GET", "/b"),
          route("GET", "/c"),
        ]),
      ),
    ).toEqual([]);
  });

  it("stop at five cards", () => {
    const model = modelOf([
      ...["/a", "/b", "/c", "/d", "/e"].map((p) =>
        route("GET", p, {
          writes: ["audit", "x", "y"],
          wrapper: "requireUser",
        }),
      ),
    ]);
    model.findings = [0, 1, 2].map((entry) => ({
      kind: "unhandledProviderCase" as const,
      severity: "warning" as const,
      description: "no branch",
      entry,
      provider: { unit: entry, line: 1 },
      consumer: { unit: entry, line: 1 },
    }));

    expect(kinds(model)).toEqual([
      "finding",
      "finding",
      "mostTablesWritten",
      "getWrites",
      "mostWrittenTable",
    ]);
  });
});
