import { describe, expect, it } from "vitest";

import {
  blanksLeftEmpty,
  fillBlanks,
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

const unitIntent = {
  kind: "boundary",
  name: "report-builder",
  purpose: "Build the report for an order.",
  audience: "the orders team",
  boundary: {
    semantics: "unit-invocation",
    deploymentTarget: "lambda",
    instanceName: "ReportBuilder",
  },
  transitions: [
    {
      id: "returns",
      when: "an order was placed",
      returns: { body: { properties: { reportId: { type: "string" } } } },
      results: [{ invokes: "unit:lambda ArchiveWorker" }],
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

  it("accepts a unit-invocation boundary intent", () => {
    expect(() => IntentDocSchema.parse(unitIntent)).not.toThrow();
  });

  it("rejects a deployment target the ir-core schema does not name", () => {
    const bad = {
      ...unitIntent,
      boundary: { ...unitIntent.boundary, deploymentTarget: "fargate" },
    };
    expect(() => IntentDocSchema.parse(bad)).toThrow();
  });

  it("takes a unit with no name, which is a unit named at run time", () => {
    const parsed = IntentDocSchema.parse({
      ...unitIntent,
      boundary: { semantics: "unit-invocation", deploymentTarget: "lambda" },
    });
    expect(parsed.kind === "boundary" && parsed.boundary).toEqual({
      semantics: "unit-invocation",
      deploymentTarget: "lambda",
      instanceName: null,
    });
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

/** The doc with a different boundary block, everything else left alone. */
function withBoundary(boundary: unknown) {
  return { ...fnIntent, boundary };
}

function receivesOf(doc: unknown) {
  return (
    intentDocToSummary(IntentDocSchema.parse(doc)) as BoundaryIntentSummary
  ).receives;
}

describe("a boundary block that rejects what it does not recognise", () => {
  it("says which key it did not recognise when receives is misspelt", () => {
    const result = IntentDocSchema.safeParse(
      withBoundary({
        semantics: "function-call",
        package: "@suss/checker",
        exportPath: ["checkPair"],
        recieves: { provider: {} },
      }),
    );
    expect(result.success).toBe(false);
    const said = result.error?.issues.map((issue) => issue.message).join("\n");
    expect(said).toContain("recieves");
  });

  it("leaves the fields that were optional optional", () => {
    const result = IntentDocSchema.safeParse(
      withBoundary({ semantics: "function-call", module: "src/check.ts" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an unknown key inside a declared field", () => {
    const result = IntentDocSchema.safeParse(
      withBoundary({
        semantics: "function-call",
        package: "@suss/checker",
        exportPath: ["checkPair"],
        receives: { provider: { type: "object", requred: true } },
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe("a document that rejects what it does not recognise", () => {
  it("says which key it did not recognise when scenarios is misspelt", () => {
    const result = IntentDocSchema.safeParse({
      ...prd,
      scenario: prd.scenarios,
    });
    expect(result.success).toBe(false);
    const said = result.error?.issues.map((issue) => issue.message).join("\n");
    expect(said).toContain("scenario");
  });

  it("says which key it did not recognise when transitions is misspelt", () => {
    const result = IntentDocSchema.safeParse({
      ...fnIntent,
      transition: fnIntent.transitions,
    });
    expect(result.success).toBe(false);
    const said = result.error?.issues.map((issue) => issue.message).join("\n");
    expect(said).toContain("transition");
  });

  it("says which key it did not recognise when a transition has a typo", () => {
    const result = IntentDocSchema.safeParse({
      ...fnIntent,
      transitions: [{ ...fnIntent.transitions[0], respones: {} }],
    });
    expect(result.success).toBe(false);
    const said = result.error?.issues.map((issue) => issue.message).join("\n");
    expect(said).toContain("respones");
  });

  it("says which key it did not recognise when a scenario has a typo", () => {
    const result = IntentDocSchema.safeParse({
      ...prd,
      scenarios: [
        { titel: "Found", when: "a known id", expect: "the profile" },
      ],
    });
    expect(result.success).toBe(false);
    const said = result.error?.issues.map((issue) => issue.message).join("\n");
    expect(said).toContain("titel");
  });

  it("leaves source optional, the one document field with a default", () => {
    expect(IntentDocSchema.safeParse(fnIntent).success).toBe(true);
    expect(IntentDocSchema.safeParse(prd).success).toBe(true);
  });
});

describe("receives, normalised to a field list", () => {
  it("splits a dotted parameter name into a path", () => {
    expect(
      receivesOf(
        withBoundary({
          semantics: "function-call",
          package: "@suss/checker",
          exportPath: ["checkPair"],
          receives: {
            "pair.provider": { type: "object", required: true },
            "options.stream": { type: "string" },
          },
        }),
      ),
    ).toEqual([
      {
        path: ["pair", "provider"],
        shape: { type: "record", properties: {} },
        required: true,
      },
      { path: ["options", "stream"], shape: { type: "text" }, required: false },
    ]);
  });

  it("takes a field with no shape at all, and defaults it to optional", () => {
    expect(
      receivesOf(
        withBoundary({
          semantics: "function-call",
          package: "@suss/checker",
          exportPath: ["checkPair"],
          receives: { provider: {}, consumer: { required: true } },
        }),
      ),
    ).toEqual([
      { path: ["provider"], shape: null, required: false },
      { path: ["consumer"], shape: null, required: true },
    ]);
  });

  it("keeps the item shape of an array field", () => {
    expect(
      receivesOf({
        ...busIntent,
        boundary: {
          semantics: "message-bus",
          messageBus: "aws_sqs",
          channel: "orders",
          receives: {
            orderId: { type: "string", required: true },
            items: { type: "array", items: { type: "object" } },
          },
        },
      }),
    ).toEqual([
      { path: ["orderId"], shape: { type: "text" }, required: true },
      {
        path: ["items"],
        shape: { type: "array", items: { type: "record", properties: {} } },
        required: false,
      },
    ]);
  });

  it("puts the section first for each part of a request", () => {
    expect(
      receivesOf({
        ...restIntent,
        boundary: {
          semantics: "rest",
          method: "POST",
          path: "/invoices/:id/settle",
          receives: {
            headers: { "x-tenant-id": { type: "string", required: true } },
            query: { dryRun: { type: "boolean" } },
            params: { id: { type: "string" } },
            body: {
              type: "object",
              properties: { note: { type: "string" } },
              required: ["note"],
            },
          },
        },
      }),
    ).toEqual([
      {
        path: ["headers", "x-tenant-id"],
        shape: { type: "text" },
        required: true,
      },
      {
        path: ["query", "dryRun"],
        shape: { type: "boolean" },
        required: false,
      },
      { path: ["params", "id"], shape: { type: "text" }, required: false },
      { path: ["body", "note"], shape: { type: "text" }, required: true },
    ]);
  });

  it("keeps a body the vocabulary spells as one value as the body field", () => {
    expect(
      receivesOf({
        ...restIntent,
        boundary: {
          semantics: "rest",
          method: "POST",
          path: "/invoices",
          receives: { body: { type: "array", items: { type: "string" } } },
        },
      }),
    ).toEqual([
      {
        path: ["body"],
        shape: { type: "array", items: { type: "text" } },
        required: false,
      },
    ]);
  });

  it("takes a request block that declares no body at all", () => {
    expect(
      receivesOf({
        ...restIntent,
        boundary: {
          semantics: "rest",
          method: "GET",
          path: "/invoices",
          receives: { query: { dryRun: { type: "boolean" } } },
        },
      }),
    ).toEqual([
      {
        path: ["query", "dryRun"],
        shape: { type: "boolean" },
        required: false,
      },
    ]);
  });

  it("leaves a body property optional when the shape names none as required", () => {
    expect(
      receivesOf({
        ...restIntent,
        boundary: {
          semantics: "rest",
          method: "POST",
          path: "/invoices",
          receives: {
            body: { type: "object", properties: { note: { type: "string" } } },
          },
        },
      }),
    ).toEqual([
      { path: ["body", "note"], shape: { type: "text" }, required: false },
    ]);
  });

  it("takes a body written with nothing under it as saying nothing", () => {
    expect(
      receivesOf({
        ...restIntent,
        boundary: {
          semantics: "rest",
          method: "POST",
          path: "/invoices",
          receives: { body: {} },
        },
      }),
    ).toEqual([]);
  });

  it("takes a receives block on a store and on an invoked unit", () => {
    expect(
      receivesOf({
        ...storeIntent,
        boundary: {
          ...storeIntent.boundary,
          receives: { invoiceId: { required: true } },
        },
      }),
    ).toEqual([{ path: ["invoiceId"], shape: null, required: true }]);
    expect(
      receivesOf({
        ...unitIntent,
        boundary: { ...unitIntent.boundary, receives: { orderId: {} } },
      }),
    ).toEqual([{ path: ["orderId"], shape: null, required: false }]);
  });

  it("is empty for a doc that says nothing about what it is handed", () => {
    expect(receivesOf(fnIntent)).toEqual([]);
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

describe("intentDocToSummary over a unit-invocation boundary", () => {
  it("builds the binding the ir-core constructor builds, and reads the invoke", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse(unitIntent),
    ) as BoundaryIntentSummary;

    expect(summary.boundary).toEqual({
      transport: "invoke",
      semantics: {
        name: "unit-invocation",
        deploymentTarget: "lambda",
        instanceName: "ReportBuilder",
      },
      recognition: "intent",
    });
    expect(summary.outcomes[0].effects).toEqual([
      {
        does: "invokes",
        names: "unit:lambda ArchiveWorker",
        fields: [],
        by: [],
      },
    ]);
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
      { does: "writes", names: "aws.dynamodb:Invoices", fields: [], by: [] },
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
        at: {
          does: "reads",
          names: "aws.dynamodb:Invoices",
          fields: [],
          by: [],
        },
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

  it("takes the columns an effect touches, and one key or several", () => {
    const withColumns = (by: unknown) =>
      intentDocToSummary(
        IntentDocSchema.parse({
          ...storeIntent,
          transitions: [
            {
              ...storeIntent.transitions[0],
              results: [
                {
                  writes: "aws.dynamodb:Invoices",
                  fields: ["email", "phone"],
                  by,
                },
              ],
            },
          ],
        }),
      ) as BoundaryIntentSummary;

    expect(withColumns("invoiceId").outcomes[0].effects[0]).toEqual({
      does: "writes",
      names: "aws.dynamodb:Invoices",
      fields: ["email", "phone"],
      by: ["invoiceId"],
    });
    expect(
      withColumns(["tenantId", "invoiceId"]).outcomes[0].effects[0].by,
    ).toEqual(["tenantId", "invoiceId"]);
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

describe("what a command prints and how it exits", () => {
  const command = {
    kind: "boundary",
    name: "cli-check",
    purpose: "suss check exits 1 when it compared nothing.",
    audience: "CI jobs",
    boundary: {
      semantics: "function-call",
      package: "@suss/cli",
      exportPath: ["runCheck"],
    },
  };

  it("reads exits as an outcome that ends with that code", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse({
        ...command,
        transitions: [{ id: "nothing-paired", when: "empty", exits: 1 }],
      }),
    ) as BoundaryIntentSummary;
    expect(summary.outcomes[0]).toMatchObject({ kind: "exit", status: 1 });
  });

  it("refuses a bare exits, and exits beside another ending", () => {
    for (const transition of [
      { id: "bare", when: "empty", exits: null },
      { id: "both", when: "empty", exits: 1, returns: {} },
    ]) {
      expect(
        IntentDocSchema.safeParse({ ...command, transitions: [transition] })
          .success,
      ).toBe(false);
    }
  });

  it("reads the shape a results line declares, with const and nested shorthand", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse({
        ...command,
        transitions: [
          {
            id: "report",
            when: "json",
            results: [
              {
                writes: "io:stdout",
                shape: {
                  properties: {
                    run: {
                      type: "array",
                      items: {
                        properties: { kind: { const: "nothingPaired" } },
                      },
                    },
                    passed: { const: false },
                  },
                },
              },
            ],
          },
        ],
      }),
    ) as BoundaryIntentSummary;
    expect(summary.outcomes[0]?.effects[0]).toEqual({
      does: "writes",
      names: "io:stdout",
      fields: [],
      by: [],
      shape: {
        type: "record",
        properties: {
          run: {
            type: "array",
            items: {
              type: "record",
              properties: {
                kind: { type: "literal", value: "nothingPaired" },
              },
            },
          },
          passed: { type: "literal", value: false },
        },
      },
    });
  });

  it("reads a whole shape pinned to one value", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse({
        ...command,
        transitions: [
          {
            id: "done",
            when: "plain",
            results: [{ writes: "io:stdout", shape: { const: "done" } }],
          },
        ],
      }),
    ) as BoundaryIntentSummary;
    expect(summary.outcomes[0]?.effects[0]?.shape).toEqual({
      type: "literal",
      value: "done",
    });
  });

  it("refuses a misspelt type instead of reading it as an empty object", () => {
    const result = IntentDocSchema.safeParse({
      ...command,
      transitions: [
        {
          id: "report",
          when: "json",
          returns: { body: { properties: { run: { typ: "array" } } } },
        },
      ],
    });
    expect(result.success).toBe(false);
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
        coveredBy: [],
        about: [],
      },
      {
        title: null,
        when: "the id is unknown",
        expect: "the caller is told it wasn't found",
        link: [],
        coveredBy: [],
        about: [],
      },
    ]);
  });
});

describe("a PRD scenario covered by a test", () => {
  const scenario = {
    title: "cancelled twice",
    when: "an order is cancelled a second time",
    expect: "the second cancel changes nothing",
  };
  const prdWith = (
    scenarios: Array<Record<string, unknown>>,
  ): Record<string, unknown> => ({
    kind: "prd",
    title: "Cancel an order",
    purpose: "A customer cancels an order they no longer want.",
    audience: "customers",
    scenarios,
  });
  const issuesOf = (doc: unknown): string[] => {
    const parsed = IntentDocSchema.safeParse(doc);
    return parsed.success
      ? []
      : parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        );
  };

  it("splits each test into its file and its titles", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse(
        prdWith([
          { ...scenario, link: "orders-cancel.cancelled" },
          {
            ...scenario,
            coveredBy: [
              "src/orders.test.ts > cancel > changes nothing the second time",
              "src/refunds.test.ts > refunds nothing twice",
            ],
            about: "fn:@acme/orders::cancelOrder",
          },
        ]),
      ),
    ) as PrdSummary;

    expect(summary.scenarios[1].coveredBy).toEqual([
      {
        spelledAs:
          "src/orders.test.ts > cancel > changes nothing the second time",
        file: "src/orders.test.ts",
        titles: ["cancel", "changes nothing the second time"],
      },
      {
        spelledAs: "src/refunds.test.ts > refunds nothing twice",
        file: "src/refunds.test.ts",
        titles: ["refunds nothing twice"],
      },
    ]);
    expect(summary.scenarios[1].about).toEqual([
      "fn:@acme/orders::cancelOrder",
    ]);
  });

  it("falls back on the PRD's links when a scenario says nothing under about", () => {
    expect(
      issuesOf(
        prdWith([
          { ...scenario, link: "orders-cancel.cancelled" },
          { ...scenario, coveredBy: "src/orders.test.ts > cancels twice" },
        ]),
      ),
    ).toEqual([]);
  });

  it("requires about in a PRD that links to nothing, and says which scenario lacks it", () => {
    expect(
      issuesOf(
        prdWith([
          { ...scenario, coveredBy: "src/orders.test.ts > cancels twice" },
        ]),
      ),
    ).toEqual([
      'scenarios.0.about: scenario "cancelled twice" lists a covering test, and no scenario in this PRD links to an outcome, so there is nothing to check the test reaches; say what it has to reach under about',
    ]);
  });

  it("refuses a test written without a title", () => {
    expect(
      issuesOf(
        prdWith([
          {
            ...scenario,
            coveredBy: "src/orders.test.ts",
            about: "fn:@acme/orders::cancelOrder",
          },
        ]),
      ),
    ).toEqual([
      'scenarios.0.coveredBy.0: scenario "cancelled twice" lists the test "src/orders.test.ts", which has no title; write the file, then each describe title, then the test\'s own title, joined with " > "',
    ]);
  });

  it("refuses about on a scenario that lists no test", () => {
    expect(
      issuesOf(
        prdWith([
          {
            ...scenario,
            link: "orders-cancel.cancelled",
            about: "fn:@acme/orders::cancelOrder",
          },
        ]),
      ),
    ).toEqual([
      'scenarios.0.about: scenario "cancelled twice" says what a covering test has to reach, and lists no test under coveredBy',
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

describe("fillBlanks", () => {
  it("writes a placeholder into a top-level blank", () => {
    const filled = fillBlanks(
      { source: "inferred", name: "get-report", purpose: "", audience: "" },
      ["purpose", "audience"],
    ) as Record<string, string>;

    expect(filled.purpose).toBe("not written yet");
    expect(filled.audience).toBe("not written yet");
    expect(filled.name).toBe("get-report");
  });

  it("writes a scenario's blanks into every scenario", () => {
    const filled = fillBlanks(
      {
        source: "inferred",
        title: "",
        scenarios: [
          { when: "", expect: "", link: "get-report.served" },
          { when: "", expect: "" },
        ],
      },
      ["title", "when", "expect"],
    ) as { title: string; scenarios: Array<Record<string, string>> };

    expect(filled.title).toBe("not written yet");
    expect(filled.scenarios).toEqual([
      {
        when: "not written yet",
        expect: "not written yet",
        link: "get-report.served",
      },
      { when: "not written yet", expect: "not written yet" },
    ]);
  });

  it("leaves a boundary document alone, since it has no scenarios", () => {
    const filled = fillBlanks({ source: "inferred", purpose: "" }, [
      "purpose",
      "when",
    ]) as Record<string, unknown>;

    expect(filled).toEqual({ source: "inferred", purpose: "not written yet" });
  });

  it("does not write over the document it was handed", () => {
    const draft = { source: "inferred", purpose: "" };
    fillBlanks(draft, ["purpose"]);

    expect(draft.purpose).toBe("");
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

describe("always: an effect on every outcome", () => {
  const withAlways = (always: unknown, transitions = restIntent.transitions) =>
    IntentDocSchema.safeParse({ ...restIntent, transitions, always });

  it("takes an effect with the outcomes it exempts, and normalizes it", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse({
        ...restIntent,
        always: [
          {
            writes: "postgresql:audit_log",
            fields: ["actor_id", "action"],
            except: ["not-found"],
          },
        ],
      }),
    ) as BoundaryIntentSummary;
    expect(summary.always).toEqual([
      {
        effect: {
          does: "writes",
          names: "postgresql:audit_log",
          fields: ["actor_id", "action"],
          by: [],
        },
        except: ["not-found"],
      },
    ]);
  });

  it("gives a document without the block an empty list", () => {
    const summary = intentDocToSummary(
      IntentDocSchema.parse(restIntent),
    ) as BoundaryIntentSummary;

    expect(summary.always).toEqual([]);
  });

  it("stops on an except id no transition has, and lists the ones it has", () => {
    const parsed = withAlways([
      { writes: "postgresql:audit_log", except: ["notfound"] },
    ]);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].path).toEqual(["always", 0, "except", 0]);
    expect(parsed.error?.issues[0].message).toContain("not-found, found");
  });

  it("stops on an except id whose outcome states only its effects", () => {
    const parsed = withAlways(
      [{ writes: "postgresql:audit_log", except: ["audited"] }],
      [
        ...restIntent.transitions,
        {
          id: "audited",
          when: "always",
          results: [{ writes: "postgresql:audit_log" }],
        },
      ] as typeof restIntent.transitions,
    );

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toContain(
      "states only its effects",
    );
  });

  it("refuses a key an effect does not take", () => {
    expect(
      withAlways([{ writes: "postgresql:audit_log", unless: ["x"] }]).success,
    ).toBe(false);
  });

  it("has a finding kind for a path without the effect", () => {
    expect(IntentFindingKindSchema.options).toContain("pathWithoutEffect");
  });
});

describe("from: where a column's value comes from", () => {
  const withResults = (results: unknown[]) =>
    IntentDocSchema.safeParse({
      ...restIntent,
      transitions: [
        {
          id: "found",
          when: "user exists",
          response: { status: 200 },
          results,
        },
      ],
    });

  it("reads each source as a path off the input, keyed by its column", () => {
    const parsed = withResults([
      {
        reads: "postgresql:orders",
        by: ["tenant_id"],
        from: { tenant_id: "input.headers.x-tenant-id" },
      },
    ]);
    expect(parsed.success).toBe(true);
    const summary = intentDocToSummary(
      parsed.data as never,
    ) as BoundaryIntentSummary;
    expect(summary.outcomes[0]?.effects).toEqual([
      {
        does: "reads",
        names: "postgresql:orders",
        fields: [],
        by: ["tenant_id"],
        from: [{ column: "tenant_id", path: ["headers", "x-tenant-id"] }],
      },
    ]);
  });

  it("stops on a column the line lists under neither fields nor by", () => {
    const parsed = withResults([
      {
        writes: "postgresql:users",
        fields: ["email"],
        from: { name: "input.body.name" },
      },
    ]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].path).toEqual([
      "transitions",
      0,
      "results",
      0,
      "from",
      "name",
    ]);
    expect(parsed.error?.issues[0].message).toContain(
      "lists name under neither fields nor by",
    );
  });

  it("stops on a source not written as a path off the input", () => {
    const parsed = withResults([
      {
        writes: "postgresql:users",
        fields: ["email"],
        from: { email: "body.email" },
      },
    ]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toContain("input.<path>");
  });

  it("is not a key an always line takes", () => {
    expect(
      IntentDocSchema.safeParse({
        ...restIntent,
        always: [
          {
            writes: "postgresql:audit_log",
            fields: ["actor_id"],
            from: { actor_id: "input.headers.x-actor-id" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("has a finding kind for a value taken from somewhere else", () => {
    expect(IntentFindingKindSchema.options).toContain("valueFromElsewhere");
  });
});
