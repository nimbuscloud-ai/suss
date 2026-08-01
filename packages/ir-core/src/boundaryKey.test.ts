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

  it("keys a message-bus binding on its bus technology and subject", () => {
    expect(
      boundaryKey(
        messageBusBinding({
          recognition: "sqs",
          messageBus: "sqs",
          channel: "jobs",
        }),
      ),
    ).toBe("bus:sqs jobs");
  });

  it("drops the bus so both written forms of a channel land in one bucket", () => {
    const qualified = boundaryKey(
      messageBusBinding({
        recognition: "cloudformation",
        messageBus: "sqs",
        channel: "default#order.placed",
      }),
    );
    const bare = boundaryKey(
      messageBusBinding({
        recognition: "aws-lambda",
        messageBus: "sqs",
        channel: "order.placed",
      }),
    );
    expect(qualified).toBe("bus:sqs order.placed");
    expect(bare).toBe(qualified);
  });

  it("keeps two buses carrying one subject in the same bucket", () => {
    // Whether they pair is `channelsPair`'s call, made inside the
    // bucket. The key cannot make it: a side that names no bus has to
    // land with the sides that do.
    expect(
      boundaryKey(
        messageBusBinding({
          recognition: "cloudformation",
          messageBus: "sqs",
          channel: "staging#order.placed",
        }),
      ),
    ).toBe("bus:sqs order.placed");
  });

  it("keeps the bus technology apart", () => {
    expect(
      boundaryKey(
        messageBusBinding({
          recognition: "cloudformation",
          messageBus: "eventbridge",
          channel: "default#order.placed",
        }),
      ),
    ).toBe("bus:eventbridge order.placed");
  });

  it("splits a channel on its first # only", () => {
    expect(
      boundaryKey(
        messageBusBinding({
          recognition: "cloudformation",
          messageBus: "eventbridge",
          channel: "default#order#placed",
        }),
      ),
    ).toBe("bus:eventbridge order#placed");
  });

  it("keeps subject case, which AWS compares byte for byte", () => {
    expect(
      boundaryKey(
        messageBusBinding({
          recognition: "cloudformation",
          messageBus: "sqs",
          channel: "OrderPlacedQueue",
        }),
      ),
    ).toBe("bus:sqs OrderPlacedQueue");
  });

  it("returns null for a channel with no subject", () => {
    expect(
      boundaryKey(
        messageBusBinding({
          recognition: "cloudformation",
          messageBus: "eventbridge",
          channel: "default#",
        }),
      ),
    ).toBeNull();
  });
});
