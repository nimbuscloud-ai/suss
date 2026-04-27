import { describe, expect, it } from "vitest";

import { deriveGraphqlContract } from "./graphqlContract.js";

describe("deriveGraphqlContract", () => {
  const SDL = `
    type Query {
      user(id: ID!): User
      users(limit: Int): [User!]!
    }
    type Mutation {
      createUser(name: String!, age: Int): User
    }
    type User { id: ID! name: String }
  `;

  it("derives return type and args from a Query field", () => {
    const c = deriveGraphqlContract(SDL, "Query", "user", "test");
    expect(c).not.toBeNull();
    expect(c?.returnType).toEqual({ type: "ref", name: "User" });
    expect(c?.args).toEqual([
      { name: "id", type: { type: "text" }, required: true },
    ]);
    expect(c?.provenance).toBe("derived");
    expect(c?.framework).toBe("test");
  });

  it("derives list and non-null wrappers", () => {
    const c = deriveGraphqlContract(SDL, "Query", "users", "test");
    expect(c?.returnType).toEqual({
      type: "array",
      items: { type: "ref", name: "User" },
    });
    expect(c?.args).toEqual([
      { name: "limit", type: { type: "number" }, required: false },
    ]);
  });

  it("derives a Mutation field", () => {
    const c = deriveGraphqlContract(SDL, "Mutation", "createUser", "test");
    expect(c?.args.map((a) => a.name)).toEqual(["name", "age"]);
    expect(c?.args[0]?.required).toBe(true);
    expect(c?.args[1]?.required).toBe(false);
  });

  it("returns null when the field doesn't exist on the type", () => {
    expect(deriveGraphqlContract(SDL, "Query", "nope", "test")).toBeNull();
  });

  it("returns null when the type doesn't exist", () => {
    expect(deriveGraphqlContract(SDL, "NoSuchType", "foo", "test")).toBeNull();
  });

  it("returns null on invalid SDL (does not throw)", () => {
    expect(
      deriveGraphqlContract("not graphql", "Query", "x", "test"),
    ).toBeNull();
  });

  it("merges fields from extend type declarations", () => {
    const sdl = `
      type Query { a: String }
      extend type Query { b: String }
    `;
    const a = deriveGraphqlContract(sdl, "Query", "a", "test");
    const b = deriveGraphqlContract(sdl, "Query", "b", "test");
    expect(a?.returnType).toEqual({ type: "text" });
    expect(b?.returnType).toEqual({ type: "text" });
  });
});
