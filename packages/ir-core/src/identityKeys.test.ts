import { describe, expect, it } from "vitest";

import {
  type BusIdentityKey,
  busIdentityKey,
  fnIdentityKey,
  type GqlIdentityKey,
  gqlIdentityKey,
} from "./identityKeys.js";

describe("fnIdentityKey and busIdentityKey", () => {
  it("mints the prefixed forms", () => {
    expect(fnIdentityKey("@acme/util", ["parse", "config"])).toBe(
      "fn:@acme/util::parse.config",
    );
    expect(busIdentityKey("aws_sqs", "order.placed")).toBe(
      "bus:aws_sqs order.placed",
    );
  });

  it("closes the bus segment over the schema's technologies", () => {
    // @ts-expect-error a technology outside the enum refuses to compile
    busIdentityKey("carrier-pigeon", "order.placed");
    // @ts-expect-error a literal without the brand cannot claim the type
    const wrong: BusIdentityKey = "bus:aws_sqs order.placed";
    expect(wrong).toBeDefined();
  });
});

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
