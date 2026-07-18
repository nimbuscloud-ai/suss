import { describe, expect, it } from "vitest";

import {
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
      // no link — pending-link
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

describe("intentDocToSummary — body shapes and outcome edges", () => {
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
