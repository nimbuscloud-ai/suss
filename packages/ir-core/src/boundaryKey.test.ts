import { describe, expect, it } from "vitest";

import {
  boundaryKey,
  functionCallBinding,
  graphqlResolverBinding,
  messageBusBinding,
  normalizePath,
  restBinding,
} from "./index.js";

describe("normalizePath", () => {
  it("converts :param to {param} and lowercases static segments", () => {
    expect(normalizePath("/Users/:id")).toBe("/users/{id}");
  });
  it("strips a trailing slash but keeps bare /", () => {
    expect(normalizePath("/users/")).toBe("/users");
    expect(normalizePath("/")).toBe("/");
  });
  it("preserves param-name case inside braces", () => {
    expect(normalizePath("/orgs/:orgId/Members")).toBe("/orgs/{orgId}/members");
  });
});

describe("boundaryKey", () => {
  it("keys a REST binding by method + normalized path", () => {
    expect(
      boundaryKey(
        restBinding({
          transport: "http",
          method: "get",
          path: "/Users/:id",
          recognition: "express",
        }),
      ),
    ).toBe("GET /users/{id}");
  });

  it("returns null for a REST binding with empty method or path", () => {
    expect(
      boundaryKey(
        restBinding({
          transport: "http",
          method: "",
          path: "",
          recognition: "x",
        }),
      ),
    ).toBeNull();
  });

  it("keys a graphql-resolver binding", () => {
    expect(
      boundaryKey(
        graphqlResolverBinding({
          transport: "http",
          recognition: "apollo",
          typeName: "Query",
          fieldName: "user",
        }),
      ),
    ).toBe("gql:Query.user");
  });

  it("keys a function-call binding only when package + exportPath are set", () => {
    expect(
      boundaryKey(
        functionCallBinding({
          transport: "in-process",
          recognition: "ts",
          package: "@acme/api",
          exportPath: ["getUser"],
        }),
      ),
    ).toBe("fn:@acme/api::getUser");
    expect(
      boundaryKey(
        functionCallBinding({ transport: "in-process", recognition: "react" }),
      ),
    ).toBeNull();
  });

  it("returns null for semantics without a defined key", () => {
    expect(
      boundaryKey(
        messageBusBinding({
          recognition: "sqs",
          messageBus: "sqs",
          channel: "jobs",
        }),
      ),
    ).toBeNull();
  });
});
