import { describe, expect, it } from "vitest";

import { graphqlSdlToSummaries } from "./index.js";

describe("graphqlSdlToSummaries", () => {
  it("emits one resolver summary per Query field", () => {
    const sdl = `
      type Query {
        user(id: ID!): User
        users: [User!]!
      }
      type User { id: ID! name: String! }
    `;
    const summaries = graphqlSdlToSummaries(sdl);
    expect(summaries.map((s) => s.identity.name).sort()).toEqual([
      "Query.user",
      "Query.users",
    ]);
    expect(summaries.every((s) => s.kind === "resolver")).toBe(true);
  });

  it("emits separate summaries for Query / Mutation / Subscription", () => {
    const sdl = `
      type Query { a: String }
      type Mutation { b: String }
      type Subscription { c: String }
    `;
    const summaries = graphqlSdlToSummaries(sdl);
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual(["Mutation.b", "Query.a", "Subscription.c"]);
  });

  it("merges fields across `extend type` declarations", () => {
    const sdl = `
      type Query { a: String }
      extend type Query { b: String }
    `;
    const summaries = graphqlSdlToSummaries(sdl);
    expect(summaries.map((s) => s.identity.name).sort()).toEqual([
      "Query.a",
      "Query.b",
    ]);
  });

  it("derives input shapes from field arguments", () => {
    const sdl = `
      type Query {
        post(id: ID!, includeDeleted: Boolean): Post
      }
      type Post { id: ID! }
    `;
    const summaries = graphqlSdlToSummaries(sdl);
    const post = summaries.find((s) => s.identity.name === "Query.post");
    const params = post?.inputs.filter(
      (i): i is Extract<typeof i, { type: "parameter" }> =>
        i.type === "parameter",
    );
    expect(params?.map((i) => i.name)).toEqual(["id", "includeDeleted"]);
    expect(params?.[0]?.shape).toEqual({ type: "text" }); // ID!
    expect(params?.[1]?.shape).toEqual({ type: "boolean" });
  });

  it("derives the return shape from the field type", () => {
    const sdl = `
      type Query {
        count: Int!
        names: [String!]!
        maybeUser: User
      }
      type User { id: ID! }
    `;
    const summaries = graphqlSdlToSummaries(sdl);
    const count = summaries.find((s) => s.identity.name === "Query.count");
    expect(count?.transitions[0]?.output).toMatchObject({
      type: "return",
      value: { type: "number" },
    });
    const names = summaries.find((s) => s.identity.name === "Query.names");
    expect(names?.transitions[0]?.output).toMatchObject({
      type: "return",
      value: { type: "array", items: { type: "text" } },
    });
    const maybeUser = summaries.find(
      (s) => s.identity.name === "Query.maybeUser",
    );
    expect(maybeUser?.transitions[0]?.output).toMatchObject({
      type: "return",
      value: { type: "ref", name: "User" },
    });
  });

  it("each summary carries graphql-resolver binding with type+field", () => {
    const sdl = "type Query { ping: String }";
    const summaries = graphqlSdlToSummaries(sdl);
    const ping = summaries[0];
    expect(ping?.identity.boundaryBinding?.semantics).toEqual({
      name: "graphql-resolver",
      typeName: "Query",
      fieldName: "ping",
    });
  });

  it("each summary has a success + throw transition", () => {
    const sdl = "type Query { ping: String }";
    const summaries = graphqlSdlToSummaries(sdl);
    const ping = summaries[0];
    expect(ping?.transitions).toHaveLength(2);
    expect(ping?.transitions[0]?.output.type).toBe("return");
    expect(ping?.transitions[1]?.output.type).toBe("throw");
  });

  it("returns no summaries for invalid SDL (does not throw)", () => {
    expect(graphqlSdlToSummaries("this is not graphql")).toEqual([]);
  });

  it("returns no summaries for SDL without root types", () => {
    const sdl = "type User { id: ID! }";
    expect(graphqlSdlToSummaries(sdl)).toEqual([]);
  });
});
