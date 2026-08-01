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

  it("returns null when path is empty (unresolved wrapper)", () => {
    const binding: BoundaryBinding = restBinding({
      transport: "http",
      method: "GET",
      path: "",
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
  method: string,
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
  messageBus: "sqs" | "eventbridge" = "sqs",
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
  messageBus: "sqs" | "eventbridge" = "sqs",
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

/** Say which Lambda a summary runs in. */
function inLambda(
  summary: BehavioralSummary,
  instanceName: string,
): BehavioralSummary {
  return {
    ...summary,
    identity: {
      ...summary.identity,
      deployableUnit: { deploymentTarget: "lambda", instanceName },
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
    expect(result.pairs[0].key).toBe("bus:sqs jobs");
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
    expect(result.pairs[0].key).toBe("bus:sqs order.placed");
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

    // Same key bucket, since the key carries the subject alone, so the
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
      "sqs",
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

    expect(result.unmatched.noBinding).toEqual([handler]);
  });
});

describe("pairSummaries across deployable units", () => {
  it("pairs a handler with the subscription declared for its own Lambda", () => {
    const handler = inLambda(
      handlerOnChannel("PostCategorize.handler", "post.created"),
      "PostCategorizeFunction",
    );
    const own = inLambda(
      subscriberOnChannel("PostCategorize.QueueEvent", "default#post.created"),
      "PostCategorizeFunction",
    );

    const result = pairSummaries([handler, own]);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].consumer).toBe(own);
  });

  it("does not pair a handler with another Lambda's subscription", () => {
    const handler = inLambda(
      handlerOnChannel("PostCategorize.handler", "post.created"),
      "PostCategorizeFunction",
    );
    const other = inLambda(
      subscriberOnChannel(
        "PostNotifyTagged.QueueEvent",
        "default#post.created",
      ),
      "PostNotifyTaggedFunction",
    );

    const result = pairSummaries([handler, other]);

    expect(result.pairs).toHaveLength(0);
    expect(result.unmatched.providers).toEqual([handler]);
    expect(result.unmatched.consumers).toEqual([other]);
  });

  it("collapses a shared subject to one pair per Lambda", () => {
    const names = [
      "PostCategorize",
      "PostNotifyTagged",
      "PostFetchUrlMetadata",
    ];
    const summaries = names.flatMap((n) => [
      inLambda(
        handlerOnChannel(`${n}.handler`, "post.created"),
        `${n}Function`,
      ),
      inLambda(
        subscriberOnChannel(`${n}.QueueEvent`, "default#post.created"),
        `${n}Function`,
      ),
    ]);

    const result = pairSummaries(summaries);

    // Three handlers and three subscriptions on one subject: nine
    // combinations, three of which name the same Lambda.
    expect(result.pairs).toHaveLength(3);
    for (const pair of result.pairs) {
      expect(pair.provider.identity.deployableUnit).toEqual(
        pair.consumer.identity.deployableUnit,
      );
    }
  });

  it("pairs when only one side names a deployable unit", () => {
    const queue = handlerOnChannel("LibraryAutoPublishQueue", "post.created");
    const subscriber = inLambda(
      subscriberOnChannel("PostCategorize.QueueEvent", "post.created"),
      "PostCategorizeFunction",
    );

    expect(pairSummaries([queue, subscriber]).pairs).toHaveLength(1);
  });

  it("keeps two sides apart when the deployment target differs", () => {
    const handler = inLambda(
      handlerOnChannel("Worker.handler", "post.created"),
      "Worker",
    );
    const subscriber = subscriberOnChannel("Worker.QueueEvent", "post.created");
    const onEcs: BehavioralSummary = {
      ...subscriber,
      identity: {
        ...subscriber.identity,
        deployableUnit: {
          deploymentTarget: "ecs-task",
          instanceName: "Worker",
        },
      },
    };

    expect(pairSummaries([handler, onEcs]).pairs).toHaveLength(0);
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
    expect(result.unmatched.noBinding).toHaveLength(0);
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

  it("puts summaries with no binding in noBinding", () => {
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
    expect(result.unmatched.noBinding).toHaveLength(1);
  });

  it("puts summaries with no path in noBinding", () => {
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
    expect(result.unmatched.noBinding).toHaveLength(1);
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
    expect(result.unmatched.noBinding).toHaveLength(0);
  });

  it("places summaries with an unrecognized kind into noBinding", () => {
    const malformed = {
      ...providerWithPath("mystery", "GET", "/x"),
      kind: "made-up" as BehavioralSummary["kind"],
    };

    const result = pairSummaries([malformed]);
    expect(result.unmatched.noBinding).toHaveLength(1);
    expect(result.pairs).toHaveLength(0);
  });
});
