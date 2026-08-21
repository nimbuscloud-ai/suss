import { describe, expect, it } from "vitest";

import {
  functionCallBinding,
  graphqlResolverBinding,
  messageBusBinding,
  restBinding,
} from "@suss/behavioral-ir";

import {
  consumer,
  provider,
  response,
  transition,
} from "../__fixtures__/pairs.js";
import { boundaryKey, normalizePath, pairSummaries } from "./pairing.js";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// normalizePath
// ---------------------------------------------------------------------------

describe("normalizePath", () => {
  it("converts Express :param to brace style", () => {
    expect(normalizePath("/users/:id")).toBe("/users/{id}");
  });

  it("converts multiple params", () => {
    expect(normalizePath("/orgs/:orgId/members/:userId")).toBe(
      "/orgs/{orgId}/members/{userId}",
    );
  });

  it("preserves already-braced params", () => {
    expect(normalizePath("/users/{id}")).toBe("/users/{id}");
  });

  it("strips trailing slash", () => {
    expect(normalizePath("/users/")).toBe("/users");
  });

  it("keeps bare /", () => {
    expect(normalizePath("/")).toBe("/");
  });

  it("lowercases static segments", () => {
    expect(normalizePath("/Users/:ID")).toBe("/users/{ID}");
  });

  it("handles path with no params", () => {
    expect(normalizePath("/health")).toBe("/health");
  });

  it("normalizes mixed styles to the same result", () => {
    expect(normalizePath("/users/:id/posts")).toBe(
      normalizePath("/users/{id}/posts"),
    );
  });
});

// ---------------------------------------------------------------------------
// boundaryKey
// ---------------------------------------------------------------------------

describe("boundaryKey", () => {
  it("returns method + normalized path", () => {
    const binding: BoundaryBinding = restBinding({
      transport: "http",
      method: "GET",
      path: "/users/:id",
      recognition: "ts-rest",
    });
    expect(boundaryKey(binding)).toBe("GET /users/{id}");
  });

  it("returns null when the source never named a path (unresolved wrapper)", () => {
    const binding: BoundaryBinding = restBinding({
      transport: "http",
      method: "GET",
      path: null,
      recognition: "fetch",
    });
    expect(boundaryKey(binding)).toBeNull();
  });

  it("returns null for function-call semantics", () => {
    const binding: BoundaryBinding = functionCallBinding({
      transport: "in-process",
      recognition: "react",
    });
    expect(boundaryKey(binding)).toBeNull();
  });

  it("keys graphql-resolver by gql:<Type>.<field>", () => {
    const binding = graphqlResolverBinding({
      transport: "http",
      recognition: "apollo",
      typeName: "Query",
      fieldName: "users",
    });
    expect(boundaryKey(binding)).toBe("gql:Query.users");
  });

  it("uppercases method", () => {
    const binding: BoundaryBinding = restBinding({
      transport: "http",
      method: "get",
      path: "/users",
      recognition: "fetch",
    });
    expect(boundaryKey(binding)).toBe("GET /users");
  });
});

// ---------------------------------------------------------------------------
// pairSummaries
// ---------------------------------------------------------------------------

function providerWithPath(
  name: string,
  method: string | null,
  path: string,
): BehavioralSummary {
  const base = provider(name, [
    transition("t-200", { output: response(200), isDefault: true }),
  ]);
  return {
    ...base,
    identity: {
      ...base.identity,
      boundaryBinding: restBinding({
        transport: "http",
        method,
        path,
        recognition: "ts-rest",
      }),
    },
  };
}

function consumerWithPath(
  name: string,
  method: string,
  path: string,
): BehavioralSummary {
  const base = consumer(name, [
    transition("ct-200", { output: { type: "return", value: null } }),
  ]);
  return {
    ...base,
    identity: {
      ...base.identity,
      boundaryBinding: restBinding({
        transport: "http",
        method,
        path,
        recognition: "fetch",
      }),
    },
  };
}

/** A code handler bound to a channel: the side that answers. */
function handlerOnChannel(
  name: string,
  channel: string,
  messageBus: "aws_sqs" | "eventbridge" = "aws_sqs",
): BehavioralSummary {
  const base = provider(name, [
    transition("t-200", { output: response(200), isDefault: true }),
  ]);
  return {
    ...base,
    identity: {
      ...base.identity,
      boundaryBinding: messageBusBinding({
        recognition: "aws-lambda",
        messageBus,
        channel,
      }),
    },
  };
}

/** A template's declared subscriber to a channel. */
function subscriberOnChannel(
  name: string,
  channel: string,
  messageBus: "aws_sqs" | "eventbridge" = "aws_sqs",
): BehavioralSummary {
  const base = consumer(name, [
    transition("ct-200", { output: { type: "return", value: null } }),
  ]);
  return {
    ...base,
    kind: "consumer",
    identity: {
      ...base.identity,
      boundaryBinding: messageBusBinding({
        recognition: "cloudformation",
        messageBus,
        channel,
      }),
    },
  };
}

describe("pairSummaries over a message bus", () => {
  it("pairs a subscriber with the handler that answers it", () => {
    const handler = handlerOnChannel("OrderPlacedFunction.handler", "jobs");
    const subscriber = subscriberOnChannel(
      "OrderPlacedFunction.QueueEvent",
      "jobs",
    );

    const result = pairSummaries([handler, subscriber]);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].provider).toBe(handler);
    expect(result.pairs[0].consumer).toBe(subscriber);
    expect(result.pairs[0].key).toBe("bus:aws_sqs jobs");
    expect(result.unmatched.providers).toHaveLength(0);
    expect(result.unmatched.consumers).toHaveLength(0);
  });

  it("pairs when only one side names its bus", () => {
    const handler = handlerOnChannel(
      "OrderPlacedFunction.handler",
      "order.placed",
    );
    const subscriber = subscriberOnChannel(
      "OrderPlacedFunction.QueueEvent",
      "default#order.placed",
    );

    const result = pairSummaries([handler, subscriber]);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].key).toBe("bus:aws_sqs order.placed");
  });

  it("pairs when both sides name the same bus", () => {
    const handler = handlerOnChannel(
      "OrderPlacedFunction.handler",
      "default#order.placed",
    );
    const subscriber = subscriberOnChannel(
      "OrderPlacedFunction.QueueEvent",
      "default#order.placed",
    );

    expect(pairSummaries([handler, subscriber]).pairs).toHaveLength(1);
  });

  it("does not pair a subject carried on two different buses", () => {
    const handler = handlerOnChannel(
      "OrderPlacedFunction.handler",
      "staging#order.placed",
    );
    const subscriber = subscriberOnChannel(
      "OrderPlacedFunction.QueueEvent",
      "default#order.placed",
    );

    const result = pairSummaries([handler, subscriber]);

    // Same key bucket, since the key uses the subject alone, so the
    // bus comparison is what has to keep them apart.
    expect(result.pairs).toHaveLength(0);
    expect(result.unmatched.providers).toEqual([handler]);
    expect(result.unmatched.consumers).toEqual([subscriber]);
  });

  it("does not pair a subject carried on two different bus technologies", () => {
    const handler = handlerOnChannel(
      "OrderPlacedFunction.handler",
      "order.placed",
      "eventbridge",
    );
    const subscriber = subscriberOnChannel(
      "OrderPlacedFunction.QueueEvent",
      "order.placed",
      "aws_sqs",
    );

    expect(pairSummaries([handler, subscriber]).pairs).toHaveLength(0);
  });

  it("leaves a summary unmatched when it shares a bucket but pairs with nothing in it", () => {
    const paired = handlerOnChannel(
      "OrderPlacedFunction.handler",
      "default#order.placed",
    );
    const wrongBus = handlerOnChannel(
      "StagingOrderPlacedFunction.handler",
      "staging#order.placed",
    );
    const subscriber = subscriberOnChannel(
      "OrderPlacedFunction.QueueEvent",
      "default#order.placed",
    );

    const result = pairSummaries([paired, wrongBus, subscriber]);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].provider).toBe(paired);
    expect(result.unmatched.providers).toEqual([wrongBus]);
  });

  it("leaves a channel with no subject out of pairing entirely", () => {
    const handler = handlerOnChannel("OrderPlacedFunction.handler", "default#");

    const result = pairSummaries([handler]);

    expect(result.unmatched.unpairable).toEqual([
      { summary: handler, reason: "unnamedBoundary" },
    ]);
  });
});

describe("pairSummaries", () => {
  it("pairs provider and consumer on same method+path", () => {
    const p = providerWithPath("getUser", "GET", "/users/:id");
    const c = consumerWithPath("UserPage", "GET", "/users/:id");

    const result = pairSummaries([p, c]);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].provider).toBe(p);
    expect(result.pairs[0].consumer).toBe(c);
    expect(result.pairs[0].key).toBe("GET /users/{id}");
    expect(result.unmatched.providers).toHaveLength(0);
    expect(result.unmatched.consumers).toHaveLength(0);
    expect(result.unmatched.unpairable).toHaveLength(0);
  });

  it("pairs two sides that spell the same parameter differently", () => {
    // A hand-written spec says {userId} where the route serving it says
    // :id, and both serve the same requests.
    const p = providerWithPath("getUser", "GET", "/users/{userId}");
    const c = consumerWithPath("UserPage", "GET", "/users/:id");

    const result = pairSummaries([p, c]);

    expect(result.pairs).toHaveLength(1);
    // The pair reports the consumer's identity, for the reason
    // pairKeyFor gives, so the name it shows is the caller's.
    expect(result.pairs[0].key).toBe("GET /users/{id}");
    expect(result.unmatched.providers).toHaveLength(0);
    expect(result.unmatched.consumers).toHaveLength(0);
  });

  it("keeps two endpoints apart when a static segment differs", () => {
    const p = providerWithPath("getUser", "GET", "/users/{id}");
    const c = consumerWithPath("OrgPage", "GET", "/orgs/{id}");

    const result = pairSummaries([p, c]);

    expect(result.pairs).toHaveLength(0);
  });

  it("keeps a parameter apart from a static segment in the same place", () => {
    const p = providerWithPath("getMe", "GET", "/users/me");
    const c = consumerWithPath("UserPage", "GET", "/users/{id}");

    const result = pairSummaries([p, c]);

    expect(result.pairs).toHaveLength(0);
  });

  it("pairs across param syntax styles (:id vs {id})", () => {
    const p = providerWithPath("getUser", "GET", "/users/:id");
    const c = consumerWithPath("UserPage", "GET", "/users/{id}");

    const result = pairSummaries([p, c]);
    expect(result.pairs).toHaveLength(1);
  });

  it("produces N x M pairs when multiple providers/consumers share a path", () => {
    const p1 = providerWithPath("getUser", "GET", "/users/:id");
    const p2 = providerWithPath("getUserV2", "GET", "/users/:id");
    const c1 = consumerWithPath("UserPage", "GET", "/users/:id");
    const c2 = consumerWithPath("UserCard", "GET", "/users/:id");

    const result = pairSummaries([p1, p2, c1, c2]);
    expect(result.pairs).toHaveLength(4);
  });

  it("does not pair different methods", () => {
    const p = providerWithPath("createUser", "POST", "/users");
    const c = consumerWithPath("UserList", "GET", "/users");

    const result = pairSummaries([p, c]);
    expect(result.pairs).toHaveLength(0);
    expect(result.unmatched.providers).toHaveLength(1);
    expect(result.unmatched.consumers).toHaveLength(1);
  });

  it("does not pair different paths", () => {
    const p = providerWithPath("getUser", "GET", "/users/:id");
    const c = consumerWithPath("OrgPage", "GET", "/orgs/:id");

    const result = pairSummaries([p, c]);
    expect(result.pairs).toHaveLength(0);
  });

  it("marks a summary with no binding unpairable for that reason", () => {
    const noBinding: BehavioralSummary = {
      kind: "handler",
      location: { file: "x.ts", range: { start: 1, end: 10 }, exportName: "x" },
      identity: { name: "x", exportPath: null, boundaryBinding: null },
      inputs: [],
      transitions: [],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
    };

    const result = pairSummaries([noBinding]);
    expect(result.pairs).toHaveLength(0);
    expect(result.unmatched.unpairable).toEqual([
      { summary: noBinding, reason: "noBoundary" },
    ]);
  });

  it("marks a function-call summary with no pairable identity unpairable", () => {
    const noPath: BehavioralSummary = {
      kind: "handler",
      location: { file: "x.ts", range: { start: 1, end: 10 }, exportName: "x" },
      identity: {
        name: "x",
        exportPath: null,
        boundaryBinding: functionCallBinding({
          transport: "http",
          recognition: "express",
        }),
      },
      inputs: [],
      transitions: [],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
    };

    const result = pairSummaries([noPath]);
    expect(result.unmatched.unpairable).toEqual([
      { summary: noPath, reason: "unnamedBoundary" },
    ]);
  });

  it("correctly separates unmatched providers and consumers", () => {
    const p = providerWithPath("getUser", "GET", "/users/:id");
    const c = consumerWithPath("HealthCheck", "GET", "/health");

    const result = pairSummaries([p, c]);
    expect(result.pairs).toHaveLength(0);
    expect(result.unmatched.providers).toHaveLength(1);
    expect(result.unmatched.providers[0].identity.name).toBe("getUser");
    expect(result.unmatched.consumers).toHaveLength(1);
    expect(result.unmatched.consumers[0].identity.name).toBe("HealthCheck");
  });

  it("handles multiple endpoints in one batch", () => {
    const p1 = providerWithPath("getUser", "GET", "/users/:id");
    const p2 = providerWithPath("listUsers", "GET", "/users");
    const c1 = consumerWithPath("UserPage", "GET", "/users/:id");
    const c2 = consumerWithPath("UserList", "GET", "/users");
    const c3 = consumerWithPath("OrgPage", "GET", "/orgs/:id");

    const result = pairSummaries([p1, p2, c1, c2, c3]);
    expect(result.pairs).toHaveLength(2);
    expect(result.unmatched.consumers).toHaveLength(1);
    expect(result.unmatched.consumers[0].identity.name).toBe("OrgPage");
  });

  it("pairs a wildcard route with every method consumers actually use", () => {
    const p = providerWithPath("pagesApi", "*", "/api/users");
    const c1 = consumerWithPath("UserPage", "GET", "/api/users");
    const c2 = consumerWithPath("UserSync", "PROPFIND", "/api/users");

    const result = pairSummaries([p, c1, c2]);
    expect(result.pairs).toHaveLength(2);
    // The pair reports the consumer's concrete method, so a reader
    // sees what is actually called rather than the wildcard.
    expect(result.pairs.map((pair) => pair.key).sort()).toEqual([
      "GET /api/users",
      "PROPFIND /api/users",
    ]);
    expect(result.unmatched.providers).toHaveLength(0);
  });

  it("does not pair a wildcard route across paths", () => {
    const p = providerWithPath("pagesApi", "*", "/api/users");
    const c = consumerWithPath("OrgPage", "GET", "/api/orgs");

    const result = pairSummaries([p, c]);
    expect(result.pairs).toHaveLength(0);
    expect(result.unmatched.providers).toEqual([p]);
  });

  it("keeps a route whose method the source never named out of pairing", () => {
    const p = providerWithPath("unreadRoute", null, "/api/users");
    const c = consumerWithPath("UserPage", "GET", "/api/users");

    const result = pairSummaries([p, c]);
    expect(result.pairs).toHaveLength(0);
    expect(result.unmatched.unpairable).toEqual([
      { summary: p, reason: "unnamedBoundary" },
    ]);
  });

  it("case-insensitive path matching", () => {
    const p = providerWithPath("getUser", "GET", "/Users/:id");
    const c = consumerWithPath("UserPage", "GET", "/users/:id");

    const result = pairSummaries([p, c]);
    expect(result.pairs).toHaveLength(1);
  });

  it("classifies non-handler provider kinds (worker, component, hook) as providers", () => {
    const workerProvider: BehavioralSummary = {
      ...providerWithPath("processOrder", "POST", "/orders"),
      kind: "worker",
    };
    const c = consumerWithPath("OrdersClient", "POST", "/orders");

    const result = pairSummaries([workerProvider, c]);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].provider.kind).toBe("worker");
    expect(result.unmatched.unpairable).toHaveLength(0);
  });

  it("marks a summary with an unrecognized kind unpairable", () => {
    const malformed = {
      ...providerWithPath("mystery", "GET", "/x"),
      kind: "made-up" as BehavioralSummary["kind"],
    };

    const result = pairSummaries([malformed]);
    expect(result.unmatched.unpairable).toEqual([
      { summary: malformed, reason: "unknownKind" },
    ]);
    expect(result.pairs).toHaveLength(0);
  });
});
