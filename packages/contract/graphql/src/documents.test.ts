import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  graphqlDocumentsPathToSummaries,
  graphqlDocumentsToSummaries,
} from "./documents.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(
  here,
  "../../../../fixtures/graphql-documents",
);

function byName(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary {
  const found = summaries.find((s) => s.identity.name === name);
  if (found === undefined) {
    throw new Error(`no summary named ${name}`);
  }
  return found;
}

describe("graphqlDocumentsToSummaries", () => {
  it("emits one client summary per operation with a graphql-operation binding", () => {
    const summaries = graphqlDocumentsToSummaries([
      {
        path: "ops.graphql",
        text: `
          query GetUser($id: ID!) { user(id: $id) { name } }
          mutation DeleteUser($id: ID!) { deleteUser(id: $id) }
        `,
      },
    ]);
    expect(summaries).toHaveLength(2);
    expect(summaries.every((s) => s.kind === "client")).toBe(true);

    const query = byName(summaries, "GetUser");
    expect(query.identity.boundaryBinding?.semantics).toEqual({
      name: "graphql-operation",
      operationType: "query",
      operationName: "GetUser",
    });
    expect(query.confidence).toEqual({ source: "declared", level: "high" });

    const mutation = byName(summaries, "DeleteUser");
    expect(mutation.identity.boundaryBinding?.semantics).toMatchObject({
      operationType: "mutation",
    });
  });

  it("turns variable definitions into role-variable inputs with shapes", () => {
    const summaries = graphqlDocumentsToSummaries([
      {
        path: "ops.graphql",
        text: `query Search($term: String!, $limit: Int, $tags: [String!]) {
          search(term: $term, limit: $limit, tags: $tags) { id }
        }`,
      },
    ]);
    expect(summaries[0]?.inputs).toEqual([
      {
        type: "parameter",
        name: "term",
        position: 0,
        role: "variable",
        shape: { type: "text" },
      },
      {
        type: "parameter",
        name: "limit",
        position: 1,
        role: "variable",
        shape: { type: "number" },
      },
      {
        type: "parameter",
        name: "tags",
        position: 2,
        role: "variable",
        shape: { type: "array", items: { type: "text" } },
      },
    ]);
  });

  it("carries the document at metadata.graphql.document", () => {
    const summaries = graphqlDocumentsToSummaries([
      {
        path: "ops.graphql",
        text: "query Ping { ping }",
      },
    ]);
    const meta = summaries[0]?.metadata?.graphql as { document: string };
    expect(meta.document).toContain("query Ping");
    expect(meta.document).toContain("ping");
  });

  it("inlines fragment spreads defined in another document", () => {
    const summaries = graphqlDocumentsToSummaries([
      {
        path: "op.graphql",
        text: "query GetUser { user { ...UserFields } }",
      },
      {
        path: "fragment.graphql",
        text: "fragment UserFields on User { id email }",
      },
    ]);
    // The fragment-only document produces no summary of its own.
    expect(summaries).toHaveLength(1);
    const meta = summaries[0]?.metadata?.graphql as { document: string };
    expect(meta.document).toContain("id");
    expect(meta.document).toContain("email");
    expect(meta.document).not.toContain("...UserFields");
    expect(summaries[0]?.gaps).toEqual([]);

    const success = summaries[0]?.transitions.find((t) => t.isDefault);
    expect(success?.output).toEqual({
      type: "return",
      value: {
        type: "record",
        properties: {
          user: {
            type: "record",
            properties: {
              id: { type: "unknown" },
              email: { type: "unknown" },
            },
          },
        },
      },
    });
  });

  it("resolves nested fragment spreads transitively", () => {
    const summaries = graphqlDocumentsToSummaries([
      {
        path: "op.graphql",
        text: "query Q { user { ...A } }",
      },
      {
        path: "fragments.graphql",
        text: `
          fragment A on User { id ...B }
          fragment B on User { email }
        `,
      },
    ]);
    const meta = summaries[0]?.metadata?.graphql as { document: string };
    expect(meta.document).toContain("email");
    expect(summaries[0]?.gaps).toEqual([]);
  });

  it("records an unresolvable fragment spread as a gap, not a crash", () => {
    const summaries = graphqlDocumentsToSummaries([
      {
        path: "op.graphql",
        text: "query Q { user { id ...Elsewhere } }",
      },
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.gaps).toHaveLength(1);
    expect(summaries[0]?.gaps[0]?.type).toBe("unreadOutcome");
    expect(summaries[0]?.gaps[0]?.description).toContain("Elsewhere");
    const meta = summaries[0]?.metadata?.graphql as {
      unresolvedFragments: string[];
    };
    expect(meta.unresolvedFragments).toEqual(["Elsewhere"]);
  });

  it("survives a fragment cycle without looping", () => {
    const summaries = graphqlDocumentsToSummaries([
      {
        path: "op.graphql",
        text: `
          query Q { user { ...A } }
          fragment A on User { id ...B }
          fragment B on User { ...A email }
        `,
      },
    ]);
    expect(summaries).toHaveLength(1);
    const meta = summaries[0]?.metadata?.graphql as { document: string };
    expect(meta.document).toContain("email");
  });

  it("names an anonymous operation after its file", () => {
    const summaries = graphqlDocumentsToSummaries([
      { path: "/some/dir/shop.graphql", text: "{ shop { name } }" },
    ]);
    expect(summaries[0]?.identity.name).toBe("shop.graphql:query");
    const semantics = summaries[0]?.identity.boundaryBinding?.semantics;
    expect(semantics).toEqual({
      name: "graphql-operation",
      operationType: "query",
    });
  });

  it("keeps inline fragments and merges their fields into the response shape", () => {
    const summaries = graphqlDocumentsToSummaries([
      {
        path: "op.graphql",
        text: `query Q {
          node { id ... on Product { name } }
        }`,
      },
    ]);
    const success = summaries[0]?.transitions.find((t) => t.isDefault);
    expect(success?.output).toEqual({
      type: "return",
      value: {
        type: "record",
        properties: {
          node: {
            type: "record",
            properties: {
              id: { type: "unknown" },
              name: { type: "unknown" },
            },
          },
        },
      },
    });
    const meta = summaries[0]?.metadata?.graphql as { document: string };
    expect(meta.document).toContain("... on Product");
  });

  it("skips a document that does not parse and keeps the rest", () => {
    const summaries = graphqlDocumentsToSummaries([
      { path: "bad.graphql", text: "query {" },
      { path: "good.graphql", text: "query Ok { ok }" },
    ]);
    expect(summaries.map((s) => s.identity.name)).toEqual(["Ok"]);
  });
});

describe("graphqlDocumentsPathToSummaries", () => {
  it("walks a directory for .graphql and .gql files", () => {
    const summaries = graphqlDocumentsPathToSummaries(fixturesDir);
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual([
      "AccountUpdate",
      "CheckoutFind",
      "ProductList",
      "anonymous.graphql:query",
    ]);
  });

  it("resolves fragments across files in the directory", () => {
    const summaries = graphqlDocumentsPathToSummaries(fixturesDir);
    const productList = summaries.find(
      (s) => s.identity.name === "ProductList",
    );
    const meta = productList?.metadata?.graphql as { document: string };
    // ProductListItem spreads PriceRange; both live in a separate
    // fragment-only file and both end up inlined.
    expect(meta.document).toContain("amount");
    expect(productList?.gaps).toEqual([]);

    const checkoutFind = summaries.find(
      (s) => s.identity.name === "CheckoutFind",
    );
    expect(checkoutFind?.gaps).toHaveLength(1);
    expect(checkoutFind?.gaps[0]?.description).toContain("CheckoutDetails");
  });

  it("accepts a single file path", () => {
    const file = path.join(fixturesDir, "accountUpdate.gql");
    const summaries = graphqlDocumentsPathToSummaries(file);
    expect(summaries.map((s) => s.identity.name)).toEqual(["AccountUpdate"]);
  });

  it("throws a readable error for a missing path", () => {
    const missing = path.join(fixturesDir, "does-not-exist");
    expect(() => graphqlDocumentsPathToSummaries(missing)).toThrow(
      /No GraphQL documents found/,
    );
  });
});
