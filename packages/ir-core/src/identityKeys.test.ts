import { describe, expect, it } from "vitest";

import { type GqlIdentityKey, gqlIdentityKey } from "./identityKeys.js";

describe("gqlIdentityKey", () => {
  it("mints the prefixed dotted form", () => {
    expect(gqlIdentityKey("Query", "posts")).toBe("gql:Query.posts");
  });

  it("refuses a plain literal at the type level", () => {
    // @ts-expect-error a literal without the brand cannot claim the type
    const wrong: GqlIdentityKey = "Query.posts";
    // @ts-expect-error even the correct spelling needs the mint
    const unminted: GqlIdentityKey = "gql:Query.posts";
    expect([wrong, unminted]).toBeDefined();
  });
});
