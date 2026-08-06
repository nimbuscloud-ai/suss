import { describe, expect, it } from "vitest";

import {
  boundaryKey,
  boundaryLabel,
  displayLabel,
  functionCallBinding,
  graphqlResolverBinding,
  messageBusBinding,
  methodsAgree,
  normalizePath,
  pairingKey,
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

  it("returns null for a REST binding whose method or path the source never named", () => {
    expect(
      boundaryKey(
        restBinding({
          transport: "http",
          method: null,
          path: null,
          recognition: "x",
        }),
      ),
    ).toBeNull();
  });

  it("refuses an empty string where a name or null belongs", () => {
    expect(() =>
      restBinding({
        transport: "http",
        method: "",
        path: "/x",
        recognition: "x",
      }),
    ).toThrow(/empty string/);

    expect(() =>
      graphqlResolverBinding({
        transport: "http",
        recognition: "x",
        typeName: "",
        fieldName: "user",
      }),
    ).toThrow(/empty string/);

    expect(() =>
      messageBusBinding({ recognition: "x", messageBus: "sqs", channel: "" }),
    ).toThrow(/empty string/);
  });

  it("keys a wildcard route as written, and buckets REST routes by path", () => {
    const wildcard = restBinding({
      transport: "http",
      method: "*",
      path: "/api/users",
      recognition: "x",
    });
    const named = restBinding({
      transport: "http",
      method: "get",
      path: "/api/users",
      recognition: "x",
    });
    expect(boundaryKey(wildcard)).toBe("* /api/users");
    expect(pairingKey(wildcard)).toBe("rest /api/users");
    expect(pairingKey(named)).toBe("rest /api/users");

    const unnamed = messageBusBinding({
      recognition: "x",
      messageBus: "sqs",
      channel: null,
    });
    expect(pairingKey(unnamed)).toBeNull();
  });

  it("agrees methods the way buses agree: equal, or a wildcard on either side", () => {
    expect(methodsAgree("GET", "GET")).toBe(true);
    expect(methodsAgree("GET", "POST")).toBe(false);
    expect(methodsAgree("*", "PROPFIND")).toBe(true);
    expect(methodsAgree("GET", "*")).toBe(true);
    expect(methodsAgree(null, "GET")).toBe(false);
    expect(methodsAgree("*", null)).toBe(false);
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

  it("has no key for a resolver whose type the source never named", () => {
    expect(
      boundaryKey(
        graphqlResolverBinding({
          transport: "http",
          recognition: "nestjs-graphql",
          typeName: null,
          fieldName: "user",
        }),
      ),
    ).toBeNull();
  });

  it("has no key for a boundary shape it does not know", () => {
    // A runtime-config or storage binding names a boundary with no
    // counterpart to pair against, so it stays out of the buckets.
    expect(
      boundaryKey({
        transport: "in-process",
        recognition: "process-env",
        semantics: {
          name: "runtime-config",
          deploymentTarget: "lambda",
          instanceName: "worker",
        },
      }),
    ).toBeNull();
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

  it("has no key for a channel that names a bus and no subject", () => {
    // `default#` says which bus and never says what travels on it, so
    // there is nothing for the other side to match.
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

describe("displayLabel", () => {
  it("shows the identity key when the protocol declares no label", () => {
    expect(
      displayLabel(
        restBinding({
          transport: "http",
          recognition: "express",
          method: "get",
          path: "/Users/:id",
        }),
      ),
    ).toBe("GET /users/{id}");
  });

  it("keeps a readable half when REST names only one", () => {
    expect(
      displayLabel(
        restBinding({
          transport: "http",
          recognition: "express",
          method: null,
          path: "/users",
        }),
      ),
    ).toBe("ANY /users");
  });

  it("shows the whole message-bus channel, bus included", () => {
    expect(
      displayLabel(
        messageBusBinding({
          recognition: "cloudformation",
          messageBus: "eventbridge",
          channel: "default#order.placed",
        }),
      ),
    ).toBe("bus:eventbridge default#order.placed");
  });

  it("says a null channel is named at runtime", () => {
    expect(
      displayLabel(
        messageBusBinding({
          recognition: "runtime-node",
          messageBus: "sqs",
          channel: null,
        }),
      ),
    ).toBe("bus:sqs (channel named at runtime)");
  });

  it("falls back to the variant and recognizer when nothing is named", () => {
    const binding = restBinding({
      transport: "http",
      recognition: "express",
      method: null,
      path: null,
    });
    expect(boundaryLabel(binding)).toBeNull();
    expect(displayLabel(binding)).toBe("rest:express");
  });
});
