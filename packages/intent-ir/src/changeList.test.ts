import { describe, expect, it } from "vitest";

import {
  ChangeListSchema,
  changeListToSummary,
  parseChangeList,
} from "./changeList.js";

function read(list: unknown) {
  return changeListToSummary(ChangeListSchema.parse(list));
}

function problems(list: unknown): string[] {
  const result = ChangeListSchema.safeParse(list);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
}

describe("the change list", () => {
  it("reads a boundary entry, an effect entry and one suss has no words for", () => {
    const list = read({
      asked: "Add POST /orders/:id/cancel.",
      changes: [
        { adds: "POST /orders/:id/cancel", outcomes: [200, 404] },
        {
          adds: { writes: "postgresql:orders", fields: ["cancelled_at"] },
          at: "POST /orders/:id/cancel",
        },
        { changes: "Order.status", note: 'gains the value "cancelled"' },
      ],
    });

    expect(list.changes).toEqual([
      {
        verb: "adds",
        subject: { kind: "boundary", names: "POST /orders/:id/cancel" },
        outcomes: [
          { kind: "response", status: 200, errorType: null },
          { kind: "response", status: 404, errorType: null },
        ],
        at: null,
        asked: "Add POST /orders/:id/cancel.",
        note: null,
      },
      {
        verb: "adds",
        subject: {
          kind: "effect",
          effect: {
            does: "writes",
            names: "postgresql:orders",
            fields: ["cancelled_at"],
            by: [],
          },
        },
        outcomes: [],
        at: "POST /orders/:id/cancel",
        asked: "Add POST /orders/:id/cancel.",
        note: null,
      },
      {
        verb: "changes",
        subject: { kind: "boundary", names: "Order.status" },
        outcomes: [],
        at: null,
        asked: "Add POST /orders/:id/cancel.",
        note: 'gains the value "cancelled"',
      },
    ]);
    expect(list.explained).toEqual([]);
  });

  it("reads returns and throws as outcomes, with or without an error type", () => {
    const [entry] = read({
      changes: [
        {
          changes: "fn:@acme/orders::cancel",
          outcomes: ["returns", "throws", { throws: "NotFoundError" }],
        },
      ],
    }).changes;

    expect(entry?.outcomes).toEqual([
      { kind: "return", status: null, errorType: null },
      { kind: "throw", status: null, errorType: null },
      { kind: "throw", status: null, errorType: "NotFoundError" },
    ]);
  });

  it("takes an entry's own quote over the list's", () => {
    const [first, second] = read({
      asked: "Add a cancel endpoint.",
      changes: [
        { adds: "POST /orders/:id/cancel" },
        { adds: "POST /orders/:id/audit", asked: "Also record who cancelled." },
      ],
    }).changes;

    expect([first?.asked, second?.asked]).toEqual([
      "Add a cancel endpoint.",
      "Also record who cancelled.",
    ]);
  });

  it("reads each explained line with its reason", () => {
    const list = read({
      changes: [],
      explained: [
        {
          changes: "POST /orders",
          outcomes: [409],
          why: "a duplicate order was charged twice",
        },
      ],
    });

    expect(list.explained).toEqual([
      {
        verb: "changes",
        subject: { kind: "boundary", names: "POST /orders" },
        outcomes: [{ kind: "response", status: 409, errorType: null }],
        at: null,
        why: "a duplicate order was charged twice",
      },
    ]);
  });

  it("takes a list with no changes, which says no behavior should change", () => {
    expect(read({}).changes).toEqual([]);
  });

  it("refuses an entry with two verbs, or none", () => {
    expect(
      problems({ changes: [{ adds: "POST /a", removes: "POST /b" }] }),
    ).toEqual(["an entry has exactly one of adds, removes or changes"]);
    expect(problems({ changes: [{ outcomes: [200] }] })).toContain(
      "an entry has exactly one of adds, removes or changes",
    );
  });

  it("refuses at on a boundary entry and outcomes on an effect entry", () => {
    expect(problems({ changes: [{ adds: "POST /a", at: "POST /b" }] })).toEqual(
      [
        "at says which boundary an effect happens at, so it goes with an effect; a boundary entry names its boundary itself",
      ],
    );
    expect(
      problems({
        changes: [{ adds: { writes: "postgresql:orders" }, outcomes: [200] }],
      }),
    ).toEqual([
      "outcomes belong to a boundary; an effect entry says what it touches instead",
    ]);
  });

  it("parses a list for another package, with the path to each problem", () => {
    expect(parseChangeList({ changes: [{ adds: "POST /a" }] })).toMatchObject({
      ok: true,
      list: { changes: [{ verb: "adds" }] },
    });
    expect(
      parseChangeList({ changes: [{ adds: "POST /a", removes: "POST /b" }] }),
    ).toEqual({
      ok: false,
      problems: [
        {
          path: "changes.0",
          message: "an entry has exactly one of adds, removes or changes",
        },
      ],
    });
  });

  it("refuses a key it does not know, an explained line with no reason, and a status out of range", () => {
    expect(problems({ changes: [{ adds: "POST /a", when: "x" }] })).not.toEqual(
      [],
    );
    expect(problems({ explained: [{ changes: "POST /a" }] })).not.toEqual([]);
    expect(
      problems({ changes: [{ adds: "POST /a", outcomes: [99] }] }),
    ).not.toEqual([]);
  });
});
