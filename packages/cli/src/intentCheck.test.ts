import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { withWrapperMetadata } from "@suss/behavioral-ir";
import { parseChangeList } from "@suss/intent-ir";

import {
  CREATE_BEFORE,
  CREATE_WITH_409,
  caller,
  calls,
  cancelRoute,
  graphqlField,
  helper,
  responds,
  route,
  touches,
} from "./__fixtures__/orderRoutes.js";
import { checkIntent, quotedIn } from "./intentCheck.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function changeList(yaml: string) {
  const parsed = parseChangeList(YAML.parse(yaml));
  if (!parsed.ok) {
    throw new Error(`the test's change list does not parse: ${yaml}`);
  }
  return parsed.list;
}

function check(
  yaml: string,
  before: BehavioralSummary[],
  after: BehavioralSummary[],
  prompts: string[] | null = null,
) {
  return checkIntent(changeList(yaml), [{ before, after }], prompts);
}

const CANCEL = cancelRoute;

describe("adds: <boundary> with outcomes", () => {
  it("is done when the diff shows the boundary added and every status is one of its outcomes", () => {
    const result = check(
      "changes:\n  - adds: POST /orders/:id/cancel\n    outcomes: [200, 404]",
      [],
      [CANCEL()],
    );

    expect(result.entries).toEqual([
      {
        said: "+ POST /orders/{id}/cancel responds 200, 404",
        verdict: "done",
        reason: null,
        units: ["src/cancel.ts::cancel"],
        asked: null,
        requested: null,
      },
    ]);
  });

  it("is not done when the boundary has no outcome with a listed status", () => {
    const result = check(
      "changes:\n  - adds: POST /orders/:id/cancel\n    outcomes: [200, 409]",
      [],
      [CANCEL()],
    );

    expect(result.entries[0]?.verdict).toBe("notDone");
    expect(result.entries[0]?.reason).toBe(
      "POST /orders/{id}/cancel does not respond 409.",
    );
  });

  it("is not done when the diff does not show the boundary at all", () => {
    const result = check(
      "changes:\n  - adds: POST /orders/:id/cancel\n    outcomes: [200]",
      [CANCEL()],
      [CANCEL()],
    );

    expect(result.entries[0]).toMatchObject({
      verdict: "notDone",
      reason:
        "the diff does not show POST /orders/{id}/cancel added or changed.",
    });
  });
});

describe("adds: { writes: S, fields: F } at B", () => {
  const ENTRY =
    "changes:\n  - adds: { writes: postgresql:orders, fields: [cancelled_at] }\n    at: POST /orders/:id/cancel";

  it("is done when B now reaches a write of S that states every field in F", () => {
    const result = check(
      ENTRY,
      [CANCEL()],
      [CANCEL([touches("write", "orders", ["cancelled_at", "status"])])],
    );

    expect(result.entries[0]).toMatchObject({
      said: "+ POST /orders/{id}/cancel writes postgresql:orders [cancelled_at]",
      verdict: "done",
      units: ["src/cancel.ts::cancel"],
    });
  });

  it("is done when the write happens in a function the route calls", () => {
    const withHelper = route(
      "POST",
      "/orders/:id/cancel",
      [responds(200, { effects: [calls("markCancelled")] })],
      "cancel",
    );

    const result = check(
      ENTRY,
      [withHelper, helper("markCancelled", [])],
      [
        withHelper,
        helper("markCancelled", [touches("write", "orders", ["cancelled_at"])]),
      ],
    );

    expect(result.entries[0]?.verdict).toBe("done");
  });

  it("is not done when the write leaves out a field in F", () => {
    const result = check(
      ENTRY,
      [CANCEL()],
      [CANCEL([touches("write", "orders", ["status"])])],
    );

    expect(result.entries[0]).toMatchObject({
      verdict: "notDone",
      reason:
        "POST /orders/{id}/cancel does not newly write postgresql:orders [cancelled_at].",
    });
  });

  it("is not done when B reached the write before the change too", () => {
    const writing = CANCEL([touches("write", "orders", ["cancelled_at"])]);

    const result = check(ENTRY, [writing], [writing]);

    expect(result.entries[0]?.verdict).toBe("notDone");
  });
});

describe("removes: ...", () => {
  it("is done for a boundary the baseline had and the change took out", () => {
    const result = check(
      "changes:\n  - removes: POST /orders/:id/cancel",
      [CANCEL()],
      [],
    );

    expect(result.entries[0]).toMatchObject({
      said: "- POST /orders/{id}/cancel",
      verdict: "done",
    });
  });

  it("is done for an outcome the baseline had and the boundary no longer has", () => {
    const before = route("GET", "/orders/:id", [
      responds(410, { when: "archived" }),
      responds(200),
    ]);
    const after = route("GET", "/orders/:id", [responds(200)]);

    const result = check(
      "changes:\n  - removes: GET /orders/:id\n    outcomes: [410]",
      [before],
      [after],
    );

    expect(result.entries[0]?.verdict).toBe("done");
  });

  it("is not done for an outcome the boundary still has", () => {
    const both = route("GET", "/orders/:id", [
      responds(410, { when: "archived" }),
      responds(200),
    ]);

    const result = check(
      "changes:\n  - removes: GET /orders/:id\n    outcomes: [410]",
      [both],
      [both],
    );

    expect(result.entries[0]).toMatchObject({
      verdict: "notDone",
      reason: "GET /orders/{id} still does, or never did, respond 410.",
    });
  });

  it("is done for an effect the baseline had and the boundary no longer reaches", () => {
    const result = check(
      "changes:\n  - removes: { writes: postgresql:audit_log }\n    at: POST /orders/:id/cancel",
      [CANCEL([touches("write", "audit_log")])],
      [CANCEL()],
    );

    expect(result.entries[0]?.verdict).toBe("done");
  });
});

describe("changes: <boundary>", () => {
  it("is done when the diff shows the boundary changed", () => {
    const result = check(
      "changes:\n  - changes: POST /orders",
      [CREATE_BEFORE],
      [CREATE_WITH_409],
    );

    expect(result.entries[0]).toMatchObject({
      said: "~ POST /orders",
      verdict: "done",
      units: ["src/create.ts::create"],
    });
  });

  it("is done for a listed status only when a new or changed outcome has it", () => {
    const asked409 = check(
      "changes:\n  - changes: POST /orders\n    outcomes: [409]",
      [CREATE_BEFORE],
      [CREATE_WITH_409],
    );
    const asked429 = check(
      "changes:\n  - changes: POST /orders\n    outcomes: [429]",
      [CREATE_BEFORE],
      [CREATE_WITH_409],
    );

    expect(asked409.entries[0]?.verdict).toBe("done");
    expect(asked429.entries[0]).toMatchObject({
      verdict: "notDone",
      reason: "no new or changed outcome at POST /orders can respond 429.",
    });
  });

  it("is not done when the diff does not show the boundary changed", () => {
    const result = check(
      "changes:\n  - changes: POST /orders",
      [CREATE_BEFORE],
      [CREATE_BEFORE],
    );

    expect(result.entries[0]?.verdict).toBe("notDone");
  });
});

describe("how an entry reads", () => {
  it("lists statuses together, then any other ending, and the reason in the base form", () => {
    const result = check(
      "changes:\n  - adds: fn:@acme/orders::cancel\n    outcomes: [404, returns, { throws: NotFoundError }]",
      [],
      [],
    );

    expect(result.entries[0]).toMatchObject({
      said: "+ fn:@acme/orders::cancel responds 404, returns, throws NotFoundError",
      verdict: "notDone",
      reason:
        "the diff does not show fn:@acme/orders::cancel added or changed.",
    });
  });

  it("says which ending is missing in the base form of the verb", () => {
    const result = check(
      "changes:\n  - adds: POST /orders/:id/cancel\n    outcomes: [200, throws]",
      [],
      [CANCEL()],
    );

    expect(result.entries[0]?.reason).toBe(
      "POST /orders/{id}/cancel does not throw.",
    );
  });
});

describe("unchecked", () => {
  it("reports a subject suss has no spelling for as unchecked, never as not done", () => {
    const result = check(
      'changes:\n  - changes: Order.status\n    note: gains the value "cancelled"',
      [],
      [],
    );

    expect(result.entries).toEqual([
      {
        said: '~ Order.status gains the value "cancelled"',
        verdict: "unchecked",
        reason:
          "suss has no boundary spelled Order.status, so it cannot check this entry.",
        units: [],
        asked: null,
        requested: null,
      },
    ]);
  });

  it("treats a route or a system:name spelling as checkable even before anything serves it", () => {
    const result = check(
      "changes:\n  - adds: POST /refunds\n  - adds: { writes: postgresql:refunds }\n    at: POST /refunds",
      [],
      [],
    );

    expect(result.entries.map((entry) => entry.verdict)).toEqual([
      "notDone",
      "notDone",
    ]);
  });
});

describe("a boundary spelled without its protocol", () => {
  const TITLE = graphqlField("Order", "title", 2);
  const NOTE = graphqlField("Order", "note", 3);
  const DELIVERY_NOTE = graphqlField("Order", "deliveryNote", 3);

  it("means the one boundary it picks out, the way suss ask reads it", () => {
    const result = check(
      "changes:\n  - removes: Order.note",
      [TITLE, NOTE],
      [TITLE],
    );

    expect(result.entries[0]).toMatchObject({
      said: "- gql:Order.note",
      verdict: "done",
      units: ["app/graphql/types/order_type.rb::Order.note"],
    });
  });

  it("counts a rename written as a removes of the old field and an adds of the new one", () => {
    const result = check(
      "changes:\n  - removes: Order.note\n  - adds: Order.deliveryNote",
      [TITLE, NOTE],
      [TITLE, DELIVERY_NOTE],
    );

    expect(result.entries.map(({ said, verdict }) => [said, verdict])).toEqual([
      ["- gql:Order.note", "done"],
      ["+ gql:Order.deliveryNote", "done"],
    ]);
    expect(result.notAsked).toEqual([]);
  });

  it("says how to write a rename when a changes entry finds the old field removed", () => {
    const result = check(
      "changes:\n  - changes: Order.note\n    note: renamed to deliveryNote",
      [TITLE, NOTE],
      [TITLE, DELIVERY_NOTE],
    );

    expect(result.entries[0]).toMatchObject({
      said: "~ gql:Order.note renamed to deliveryNote",
      verdict: "notDone",
      reason:
        "the diff shows gql:Order.note removed. A rename is a removes entry for the old name and an adds entry for the new one.",
    });
  });

  it("leaves a spelling that could mean several boundaries unchecked, and lists them", () => {
    const result = check(
      "changes:\n  - changes: Order",
      [TITLE, NOTE],
      [TITLE, DELIVERY_NOTE],
    );

    expect(result.entries[0]).toMatchObject({
      verdict: "unchecked",
      reason:
        "Order could mean 3 boundaries here: gql:Order.deliveryNote, gql:Order.note, gql:Order.title, so suss cannot check this entry. Spell out the one it is about.",
    });
  });

  it("keeps a route as written when it only partly matches a route that exists", () => {
    const result = check("changes:\n  - adds: POST /orders", [], [CANCEL()]);

    expect(result.entries[0]).toMatchObject({
      said: "+ POST /orders",
      verdict: "notDone",
      reason: "the diff does not show POST /orders added or changed.",
    });
  });
});

describe("not asked", () => {
  it("lists a change at a boundary no entry is about", () => {
    const result = check(
      "changes:\n  - adds: POST /orders/:id/cancel\n    outcomes: [200, 404]",
      [CREATE_BEFORE],
      [CANCEL(), CREATE_WITH_409],
    );

    expect(result.notAsked).toHaveLength(1);
    expect(result.notAsked[0]?.boundary).toBe("POST /orders");
    expect(result.notAsked[0]?.lines).toContainEqual(
      expect.objectContaining({
        does: "serves",
        change: "added",
        text: ["+ responds 409  when  open"],
        conditionMoved: false,
      }),
    );
  });

  it("lists an extra outcome from the handler's own body at a boundary an entry is about", () => {
    const withValidation = route(
      "POST",
      "/orders/:id/cancel",
      [
        responds(400, { when: "!req.params.id" }),
        responds(404, { when: "!found" }),
        responds(200),
      ],
      "cancel",
    );

    const result = check(
      "changes:\n  - adds: POST /orders/:id/cancel\n    outcomes: [200, 404]",
      [],
      [withValidation],
    );

    expect(
      result.notAsked.flatMap((change) => change.lines.map((l) => l.text)),
    ).toEqual([["+ responds 400  when  !req.params.id"]]);
  });

  it("asks for an outcome whose condition only moved beside the new branch", () => {
    const result = check(
      "changes:\n  - changes: POST /orders\n    outcomes: [409]",
      [CREATE_BEFORE],
      [CREATE_WITH_409],
    );

    expect(result.notAsked).toEqual([]);
  });

  it("asks for every effect at a boundary an entry is about", () => {
    const result = check(
      "changes:\n  - adds: POST /orders/:id/cancel\n    outcomes: [200, 404]",
      [],
      [CANCEL([touches("write", "audit_log")])],
    );

    expect(result.notAsked).toEqual([]);
  });

  it("asks for an effect at every boundary when the entry gives no at", () => {
    const orders = route("GET", "/orders", [
      responds(200, { effects: [calls("audit")] }),
    ]);
    const invoices = route(
      "GET",
      "/invoices",
      [responds(200, { effects: [calls("audit")] })],
      "invoices",
    );

    const result = check(
      "changes:\n  - adds: { writes: postgresql:audit_log }",
      [orders, invoices, helper("audit", [])],
      [orders, invoices, helper("audit", [touches("write", "audit_log")])],
    );

    expect(result.entries[0]?.verdict).toBe("done");
    expect(result.notAsked).toEqual([]);
  });

  it("asks for a caller's change at a boundary an entry is about", () => {
    const before = caller([responds(201)]);
    const after = caller([
      {
        ...responds(201),
        id: "handles-409",
        output: { type: "throw", exceptionType: "Error", message: null },
        conditions: [
          { type: "opaque", sourceText: "409", reason: "unsupportedSyntax" },
        ],
        isDefault: false,
      },
      responds(201),
    ]);

    const result = check(
      "changes:\n  - changes: POST /orders\n    outcomes: [409]",
      [CREATE_BEFORE, before],
      [CREATE_WITH_409, after],
    );

    expect(result.notAsked).toEqual([]);
  });

  it("keeps a change an explained line covers, with the reason", () => {
    const result = check(
      [
        "changes:",
        "  - adds: POST /orders/:id/cancel",
        "    outcomes: [200, 404]",
        "explained:",
        "  - changes: POST /orders",
        "    outcomes: [409]",
        "    why: a duplicate order was charged twice",
      ].join("\n"),
      [CREATE_BEFORE],
      [CANCEL(), CREATE_WITH_409],
    );

    expect(result.notAsked).toEqual([]);
    expect(result.explained).toEqual([
      {
        said: "~ POST /orders responds 409",
        why: "a duplicate order was charged twice",
        lines: [
          expect.objectContaining({ text: ["+ responds 409  when  open"] }),
        ],
      },
    ]);
  });

  it("lists an outcome a wrapper brought apart, and never counts it", () => {
    const filter = { file: "src/auth.ts", name: "requireLogin", line: 3 };
    const guarded = {
      ...CANCEL(),
      transitions: [
        {
          ...responds(401, { when: "!session" }),
          metadata: withWrapperMetadata(undefined, { from: filter }),
        },
        ...CANCEL().transitions,
      ],
    };

    const result = check(
      "changes:\n  - changes: GET /health",
      [CANCEL()],
      [guarded],
    );

    expect(result.notAsked).toEqual([]);
    expect(result.fromWrappers).toEqual([
      {
        from: filter,
        change: "added",
        outcome: "responds 401  when  !session",
        at: ["POST /orders/{id}/cancel"],
      },
    ]);
  });
});

describe("the developer's words", () => {
  const PROMPT =
    "Add POST /orders/:id/cancel. Cancelling sets cancelled_at. Return 404 when the order does not exist.";

  it("flags an entry whose quote no message contains", () => {
    const result = check(
      [
        'asked: "Add POST /orders/:id/cancel."',
        "changes:",
        "  - adds: POST /orders/:id/cancel",
        "  - changes: POST /orders",
        '    asked: "Also refuse a duplicate order."',
      ].join("\n"),
      [CREATE_BEFORE],
      [CANCEL(), CREATE_WITH_409],
      [PROMPT],
    );

    expect(result.entries.map((entry) => entry.requested)).toEqual([
      true,
      false,
    ]);
    expect(result.entries[1]?.verdict).toBe("done");
  });

  it("flags an entry that quotes nothing, when there are messages to check against", () => {
    const result = check(
      "changes:\n  - adds: POST /orders/:id/cancel",
      [],
      [CANCEL()],
      [PROMPT],
    );

    expect(result.entries[0]?.requested).toBe(false);
  });

  it("reads ... as a gap, and ignores case, spacing and the kind of quote mark", () => {
    expect(
      quotedIn("add POST /orders/:id/cancel ... 404 when the order", [PROMPT]),
    ).toBe(true);
    expect(quotedIn("cancelling   sets cancelled_at", [PROMPT])).toBe(true);
    expect(quotedIn("it’s", ["It's done"])).toBe(true);
    expect(quotedIn("404 ... add POST", [PROMPT])).toBe(false);
    expect(quotedIn("...", [PROMPT])).toBe(false);
  });
});
