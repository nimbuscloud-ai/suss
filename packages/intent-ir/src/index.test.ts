import { describe, expect, it } from "vitest";

import {
  blanksLeftEmpty,
  IntentDocSchema,
  IntentFindingKindSchema,
  intentDocToSummary,
} from "./index.js";

import type { BoundaryIntentSummary, PrdSummary } from "./index.js";

const restIntent = {
  kind: "boundary",
  name: "users-lookup",
  purpose: "GET /users/:id retrieves a user.",
  audience: "web-client",
  boundary: { semantics: "rest", method: "GET", path: "/users/:id" },
  transitions: [
    {
      id: "not-found",
      when: "user missing",
      response: {
        status: 404,
        body: { properties: { error: { type: "string" } } },
      },
    },
    {
      id: "found",
      when: "user exists",
      response: {
        status: 200,
        body: {
          properties: { id: { type: "string" }, name: { type: "string" } },
        },
      },
    },
  ],
};

const fnIntent = {
  kind: "boundary",
  name: "contract-command",
  purpose: "suss contract turns a declared source into summaries.",
  audience: "suss-cli-user",
  boundary: {
    semantics: "function-call",
    package: "@suss/cli",
    exportPath: ["contract"],
  },
  transitions: [
    {
      id: "summaries",
      when: "source is a known reader",
      returns: { body: { properties: { length: { type: "integer" } } } },
    },
    {
      id: "unknown-source",
      when: "source is not recognized",
      throws: { errorType: "Error" },
    },
  ],
};

const busIntent = {
  kind: "boundary",
  name: "invoice-intake",
  purpose: "Record every paid invoice once.",
  audience: "the billing team",
  boundary: {
    semantics: "message-bus",
    messageBus: "aws_sqs",
    channel: "billing.invoicePaid",
  },
  transitions: [
    {
      id: "invoice-recorded",
      when: "the message names an invoice we have not recorded",
      returns: { body: { properties: { recorded: { type: "boolean" } } } },
      results: [{ writes: "aws.dynamodb:Invoices" }],
    },
    {
      id: "invoice-rejected",
      when: "the message has no invoice id",
      throws: { errorType: "Error" },
    },
  ],
};

const storeIntent = {
  kind: "boundary",
  name: "invoices-table",
  purpose: "Keep one row per paid invoice.",
  audience: "the billing team",
  boundary: {
    semantics: "storage",
    storageSystem: "aws.dynamodb",
    container: "Invoices",
  },
  transitions: [
    {
      id: "invoice-row-written",
      when: "an invoice has been paid",
      results: [{ writes: "aws.dynamodb:Invoices" }],
    },
  ],
};

const prd = {
  kind: "prd",
  title: "User profile lookup",
  purpose: "Fetch a user's profile by id.",
  audience: "web-client",
  scenarios: [
    {
      title: "Found",
      when: "a request arrives with a known id",
      expect: "the caller receives the profile",
      link: "users-lookup.found",
    },
    {
      when: "the id is unknown",
      expect: "the caller is told it wasn't found",
      // no link: pending-link
    },
  ],
};

describe("IntentDocSchema validation", () => {
  it("accepts a REST boundary intent", () => {
    expect(() => IntentDocSchema.parse(restIntent)).not.toThrow();
  });

  it("accepts a function-call boundary intent", () => {
    expect(() => IntentDocSchema.parse(fnIntent)).not.toThrow();
  });

  it("accepts a PRD with an unlinked scenario", () => {
    expect(() => IntentDocSchema.parse(prd)).not.toThrow();
  });

  it("rejects a transition with two outcomes", () => {
    const bad = {
      ...restIntent,
      transitions: [
        {
          id: "x",
          when: "y",
          response: { status: 200 },
          throws: { errorType: "Error" },
        },
      ],
    };
    expect(() => IntentDocSchema.parse(bad)).toThrow();
  });

  it("rejects a transition with no outcome", () => {
    const bad = {
      ...restIntent,
      transitions: [{ id: "x", when: "y" }],
    };
    expect(() => IntentDocSchema.parse(bad)).toThrow();
  });

  it("defaults source to author", () => {
    const parsed = IntentDocSchema.parse(restIntent);
    expect(parsed.source).toBe("author");
  });

  it("accepts a message-bus boundary intent", () => {
    expect(() => IntentDocSchema.parse(busIntent)).not.toThrow();
  });

  it("accepts a storage boundary intent", () => {
    expect(() => IntentDocSchema.parse(storeIntent)).not.toThrow();
  });

  it("rejects a bus the ir-core schema does not name", () => {
    const bad = {
      ...busIntent,
      boundary: { ...busIntent.boundary, messageBus: "rabbitmq" },
    };
    expect(() => IntentDocSchema.parse(bad)).toThrow();
  });

  it("takes a bus channel and a store scope as written, or their defaults", () => {
    const bus = IntentDocSchema.parse({
      ...busIntent,
      boundary: { semantics: "message-bus", messageBus: "kafka" },
    });
    const store = IntentDocSchema.parse(storeIntent);
    expect(bus.kind === "boundary" && bus.boundary).toEqual({
      semantics: "message-bus",
      messageBus: "kafka",
      channel: null,
    });
    expect(store.kind === "boundary" && store.boundary).toEqual({
      semantics: "storage",
      storageSystem: "aws.dynamodb",
      scope: "default",
      container: "Invoices",
      accessPath: null,
    });
  });

  it("rejects an effect verb that is not one a unit does at a boundary", () => {
    const bad = {
      ...storeIntent,
      transitions: [
        {
          ...storeIntent.transitions[0],
          results: [{ provides: "aws.dynamodb:Invoices" }],
        },
      ],
    };
    expect(() => IntentDocSchema.parse(bad)).toThrow();
  });

  it("takes a when written as clauses, and one written as a sentence", () => {
    const clauses = {
      ...storeIntent,
      transitions: [
        {
          ...storeIntent.transitions[0],
          when: [
            { reads: "aws.dynamodb:Invoices", finds: "nothing" },
            "the caller asked for the settled ones",
          ],
        },
      ],
    };
    expect(() => IntentDocSchema.parse(clauses)).not.toThrow();
    expect(() => IntentDocSchema.parse(storeIntent)).not.toThrow();
  });

  it("rejects a clause that says two things about its subject", () => {
    const bad = {
      ...storeIntent,
      transitions: [
        {
          ...storeIntent.transitions[0],
          when: [
            { reads: "aws.dynamodb:Invoices", finds: "nothing", is: "missing" },
          ],
        },
      ],
    };
    expect(() => IntentDocSchema.parse(bad)).toThrow();
  });

  it("rejects a clause with no subject and a finds nobody spells", () => {
    expect(() =>
      IntentDocSchema.parse({
        ...storeIntent,
        transitions: [
          { ...storeIntent.transitions[0], when: [{ finds: "nothing" }] },
        ],
      }),
    ).toThrow();
    expect(() =>
      IntentDocSchema.parse({
        ...storeIntent,
        transitions: [
          {
            ...storeIntent.transitions[0],
            when: [{ reads: "aws.dynamodb:Invoices", finds: "a row" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects an effect that gives two verbs at once", () => {
    const bad = {
      ...storeIntent,
      transitions: [
        {
          ...storeIntent.transitions[0],
          results: [
            { reads: "aws.dynamodb:Invoices", writes: "aws.dynamodb:Invoices" },
          ],
        },
      ],
    };
    expect(() => IntentDocSchema.parse(bad)).toThrow();
  });
});

describe("intentDocToSummary — REST boundary", () => {
  it("builds a rest BoundaryBinding and response outcomes", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse(restIntent),
    ) as BoundaryIntentSummary;
    expect(summary.kind).toBe("boundary");
    expect(summary.boundary).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/:id" },
      recognition: "intent",
    });
    expect(summary.outcomes.map((o) => [o.id, o.kind, o.status])).toEqual([
      ["not-found", "response", 404],
      ["found", "response", 200],
    ]);
    expect(summary.outcomes[1].body).toEqual({
      type: "record",
      properties: { id: { type: "text" }, name: { type: "text" } },
    });
  });
});

describe("intentDocToSummary — function-call boundary", () => {
  it("builds a function-call binding and return/throw outcomes", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse(fnIntent),
    ) as BoundaryIntentSummary;
    expect(summary.boundary.semantics).toEqual({
      name: "function-call",
      package: "@suss/cli",
      exportPath: ["contract"],
    });
    const byId = Object.fromEntries(summary.outcomes.map((o) => [o.id, o]));
    expect(byId.summaries.kind).toBe("return");
    expect(byId.summaries.status).toBeNull();
    expect(byId["unknown-source"].kind).toBe("throw");
    expect(byId["unknown-source"].errorType).toBe("Error");
  });
});

describe("intentDocToSummary — message-bus and storage boundaries", () => {
  it("builds the message-bus binding the ir-core constructor builds", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse(busIntent),
    ) as BoundaryIntentSummary;

    expect(summary.boundary).toEqual({
      transport: "aws_sqs",
      semantics: {
        name: "message-bus",
        messageBus: "aws_sqs",
        channel: "billing.invoicePaid",
      },
      recognition: "intent",
    });
  });

  it("reads the verb off the key and the boundary off the value", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse(busIntent),
    ) as BoundaryIntentSummary;

    expect(summary.outcomes[0].effects).toEqual([
      { does: "writes", names: "aws.dynamodb:Invoices" },
    ]);
    expect(summary.outcomes[1].effects).toEqual([]);
  });

  it("normalises a when clause into the boundary it says and one line", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse({
        ...storeIntent,
        transitions: [
          {
            ...storeIntent.transitions[0],
            when: [
              {
                reads: "aws.dynamodb:Invoices",
                finds: "something",
                where: "settledAt is set",
              },
              "the caller asked for the settled ones",
            ],
          },
        ],
      }),
    ) as BoundaryIntentSummary;

    expect(summary.outcomes[0].conditions).toEqual([
      {
        at: { does: "reads", names: "aws.dynamodb:Invoices" },
        input: null,
        finds: "something",
        said: "reads aws.dynamodb:Invoices finds something where settledAt is set",
      },
      {
        at: null,
        input: null,
        finds: null,
        said: "the caller asked for the settled ones",
      },
    ]);
    expect(summary.outcomes[0].when).toBe(
      "reads aws.dynamodb:Invoices finds something where settledAt is set and the caller asked for the settled ones",
    );
  });

  it("normalises a clause about what the caller sent", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse({
        ...storeIntent,
        transitions: [
          {
            ...storeIntent.transitions[0],
            when: [{ input: "request.params.id", is: "missing" }],
          },
        ],
      }),
    ) as BoundaryIntentSummary;

    expect(summary.outcomes[0].conditions).toEqual([
      {
        at: null,
        input: "request.params.id",
        finds: null,
        said: "input request.params.id is missing",
      },
    ]);
  });

  it("keeps a when written as one sentence exactly as written", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse(storeIntent),
    ) as BoundaryIntentSummary;

    expect(summary.outcomes[0].when).toBe("an invoice has been paid");
    expect(summary.outcomes[0].conditions).toEqual([
      {
        at: null,
        input: null,
        finds: null,
        said: "an invoice has been paid",
      },
    ]);
  });

  it("gives an outcome that states only its effects the effect kind", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse(storeIntent),
    ) as BoundaryIntentSummary;

    expect(summary.outcomes[0].kind).toBe("effect");
    expect(summary.outcomes[0].status).toBeNull();
    expect(summary.outcomes[0].body).toBeNull();
    expect(summary.boundary.semantics.name).toBe("storage");
  });
});

describe("intentDocToSummary — body shapes and outcome edges", () => {
  it("maps arrays and nested objects onto TypeShape recursively", () => {
    const doc = {
      kind: "boundary",
      name: "nested",
      purpose: "arrays and nested records",
      audience: "test",
      boundary: { semantics: "function-call", exportName: "f" },
      transitions: [
        {
          id: "result",
          when: "always",
          returns: {
            body: {
              type: "object",
              properties: {
                findings: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { kind: { type: "string" } },
                  },
                },
                bare: { type: "array" },
              },
            },
          },
        },
        {
          id: "list",
          when: "top-level array return",
          returns: {
            body: { type: "array", items: { type: "string" } },
          },
        },
      ],
    };
    const summary = intentDocToSummary(
      IntentDocSchema.parse(doc),
    ) as BoundaryIntentSummary;
    expect(summary.outcomes[0].body).toEqual({
      type: "record",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "record",
            properties: { kind: { type: "text" } },
          },
        },
        bare: { type: "array", items: { type: "unknown" } },
      },
    });
    expect(summary.outcomes[1].body).toEqual({
      type: "array",
      items: { type: "text" },
    });
  });

  it("maps every primitive type onto its TypeShape", () => {
    const doc = {
      kind: "boundary",
      name: "types",
      purpose: "exercise every primitive",
      audience: "test",
      boundary: { semantics: "function-call", exportName: "f" },
      transitions: [
        {
          id: "all",
          when: "always",
          returns: {
            body: {
              properties: {
                s: { type: "string" },
                i: { type: "integer" },
                n: { type: "number" },
                b: { type: "boolean" },
                z: { type: "null" },
                u: { type: "unknown" },
              },
            },
          },
        },
      ],
    };
    const summary = intentDocToSummary(
      IntentDocSchema.parse(doc),
    ) as BoundaryIntentSummary;
    expect(summary.outcomes[0].body).toEqual({
      type: "record",
      properties: {
        s: { type: "text" },
        i: { type: "integer" },
        n: { type: "number" },
        b: { type: "boolean" },
        z: { type: "null" },
        u: { type: "unknown" },
      },
    });
  });

  it("yields a null body for a return outcome with no body", () => {
    const doc = {
      kind: "boundary",
      name: "void-return",
      purpose: "returns nothing",
      audience: "test",
      boundary: { semantics: "function-call", exportName: "f" },
      transitions: [{ id: "ok", when: "always", returns: {} }],
    };
    const summary = intentDocToSummary(
      IntentDocSchema.parse(doc),
    ) as BoundaryIntentSummary;
    expect(summary.outcomes[0].kind).toBe("return");
    expect(summary.outcomes[0].body).toBeNull();
  });

  it("treats a null outcome (bare `returns:` in YAML) as body-less", () => {
    // YAML `returns:` with no value parses to null; it must mean the
    // same as `returns: {}`, not fail as "expected object, received null".
    const doc = {
      kind: "boundary",
      name: "bare-returns",
      purpose: "returns a value, body unspecified",
      audience: "test",
      boundary: { semantics: "function-call", exportName: "f" },
      transitions: [{ id: "ok", when: "always", returns: null }],
    };
    const summary = intentDocToSummary(
      IntentDocSchema.parse(doc),
    ) as BoundaryIntentSummary;
    expect(summary.outcomes[0].kind).toBe("return");
    expect(summary.outcomes[0].body).toBeNull();
  });

  it("treats a null throws outcome as a body-less throw", () => {
    const doc = {
      kind: "boundary",
      name: "bare-throws",
      purpose: "throws, error type unspecified",
      audience: "test",
      boundary: { semantics: "function-call", exportName: "f" },
      transitions: [{ id: "boom", when: "on error", throws: null }],
    };
    const summary = intentDocToSummary(
      IntentDocSchema.parse(doc),
    ) as BoundaryIntentSummary;
    expect(summary.outcomes[0].kind).toBe("throw");
  });

  it("yields a null body for a response body with no declared properties", () => {
    const doc = {
      kind: "boundary",
      name: "empty-body",
      purpose: "200 with an unspecified body",
      audience: "test",
      boundary: { semantics: "rest", method: "GET", path: "/x" },
      transitions: [
        { id: "ok", when: "always", response: { status: 200, body: {} } },
      ],
    };
    const summary = intentDocToSummary(
      IntentDocSchema.parse(doc),
    ) as BoundaryIntentSummary;
    expect(summary.outcomes[0].body).toBeNull();
  });
});

describe("intentDocToSummary — PRD", () => {
  it("normalises scenarios, with expect as an array (empty when unlinked)", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse(prd),
    ) as PrdSummary;
    expect(summary.kind).toBe("prd");
    expect(summary.scenarios).toEqual([
      {
        title: "Found",
        when: "a request arrives with a known id",
        expect: "the caller receives the profile",
        link: ["users-lookup.found"],
      },
      {
        title: null,
        when: "the id is unknown",
        expect: "the caller is told it wasn't found",
        link: [],
      },
    ]);
  });
});

describe("blanksLeftEmpty", () => {
  const draft = { source: "inferred" };

  it("names both blanks when both failed", () => {
    expect(blanksLeftEmpty(draft, ["purpose", "audience"])).toEqual([
      "purpose",
      "audience",
    ]);
  });

  it("names the one blank that failed", () => {
    expect(blanksLeftEmpty(draft, ["audience"])).toEqual(["audience"]);
  });

  it("says nothing when the draft failed on something else too", () => {
    expect(blanksLeftEmpty(draft, ["purpose", "transitions"])).toEqual([]);
  });

  it("says nothing when nothing failed", () => {
    expect(blanksLeftEmpty(draft, [])).toEqual([]);
  });

  it("says nothing about a doc a person wrote or curated", () => {
    expect(blanksLeftEmpty({ source: "author" }, ["purpose"])).toEqual([]);
    expect(
      blanksLeftEmpty({ source: "inferred, curated" }, ["purpose"]),
    ).toEqual([]);
    expect(blanksLeftEmpty({}, ["purpose"])).toEqual([]);
  });
});

describe("IntentFindingKindSchema", () => {
  it("carries the PRD scenario-coverage kinds alongside the boundary kinds", () => {
    expect(IntentFindingKindSchema.options).toEqual(
      expect.arrayContaining([
        "unlinkedScenario",
        "danglingScenarioLink",
        "ambiguousScenarioLink",
      ]),
    );
  });
});
