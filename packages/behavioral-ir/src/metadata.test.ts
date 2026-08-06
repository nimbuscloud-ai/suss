import { describe, expect, it } from "vitest";

import {
  readGraphqlMetadata,
  readMessageBusMetadata,
  readRuntimeContractMetadata,
  withGraphqlMetadata,
  withMessageBusMetadata,
  withRuntimeContractMetadata,
} from "./index.js";

import type { BehavioralSummary } from "./index.js";

function summaryWith(
  metadata: Record<string, unknown> | undefined,
): BehavioralSummary {
  return {
    kind: "consumer",
    location: {
      file: "template.yaml",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: "OrderConsumer",
      exportPath: null,
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

describe("the messageBus metadata namespace", () => {
  it("round-trips what a writer sets", () => {
    const metadata = withMessageBusMetadata(
      { codeScope: { kind: "codeUri", path: "src/consumer/" } },
      { queue: "OrdersQueue", patternResolution: "exact" },
    );
    const read = readMessageBusMetadata(summaryWith(metadata));
    expect(read?.queue).toBe("OrdersQueue");
    expect(read?.patternResolution).toBe("exact");
    // Neighboring namespaces survive the merge.
    expect(metadata.codeScope).toEqual({
      kind: "codeUri",
      path: "src/consumer/",
    });
  });

  it("answers undefined when the namespace is absent or not an object", () => {
    expect(readMessageBusMetadata(summaryWith(undefined))).toBeUndefined();
    expect(
      readMessageBusMetadata(summaryWith({ messageBus: 42 })),
    ).toBeUndefined();
  });

  it("drops a field that does not parse and keeps its siblings", () => {
    const read = readMessageBusMetadata(
      summaryWith({
        messageBus: { queue: "OrdersQueue", patternResolution: "unresolved" },
      }),
    );
    expect(read?.queue).toBe("OrdersQueue");
    expect(read?.patternResolution).toBeUndefined();
  });

  it("refuses a value the schema does not name at write time", () => {
    expect(() =>
      withMessageBusMetadata(undefined, {
        // @ts-expect-error a renamed field fails to compile; the parse
        // catches a caller that casts around the type.
        queueLogicalId: "OrdersQueue",
      }),
    ).toThrow();
  });
});

describe("the runtimeContract metadata namespace", () => {
  it("round-trips what a writer sets", () => {
    const metadata = withRuntimeContractMetadata(
      { codeScope: { kind: "codeUri", path: "src/consumer/" } },
      {
        envVars: ["ORDERS_QUEUE_URL"],
        envVarSources: { ORDERS_QUEUE_URL: "template" },
      },
    );
    const read = readRuntimeContractMetadata(summaryWith(metadata));
    expect(read?.envVars).toEqual(["ORDERS_QUEUE_URL"]);
    expect(read?.envVarSources).toEqual({ ORDERS_QUEUE_URL: "template" });
    // Neighboring namespaces survive the merge.
    expect(metadata.codeScope).toEqual({
      kind: "codeUri",
      path: "src/consumer/",
    });
  });

  it("answers undefined when the namespace is absent or not an object", () => {
    expect(readRuntimeContractMetadata(summaryWith(undefined))).toBeUndefined();
    expect(
      readRuntimeContractMetadata(summaryWith({ runtimeContract: 42 })),
    ).toBeUndefined();
  });

  it("drops a field that does not parse and keeps its siblings", () => {
    const read = readRuntimeContractMetadata(
      summaryWith({
        runtimeContract: {
          envVars: ["ORDERS_QUEUE_URL"],
          envVarTargets: {
            ORDERS_QUEUE_URL: { kind: "getAtt", logicalId: "OrdersQueue" },
          },
        },
      }),
    );
    expect(read?.envVars).toEqual(["ORDERS_QUEUE_URL"]);
    expect(read?.envVarTargets).toBeUndefined();
  });

  it("drops envVarSources when a value falls outside the enum, and envVars survives", () => {
    const read = readRuntimeContractMetadata(
      summaryWith({
        runtimeContract: {
          envVars: ["ORDERS_QUEUE_URL"],
          envVarSources: { ORDERS_QUEUE_URL: "carrier-pigeon" },
        },
      }),
    );
    expect(read?.envVars).toEqual(["ORDERS_QUEUE_URL"]);
    expect(read?.envVarSources).toBeUndefined();
  });

  it("refuses a value the schema does not name at write time", () => {
    expect(() =>
      withRuntimeContractMetadata(undefined, {
        // @ts-expect-error a renamed field fails to compile; the parse
        // catches a caller that casts around the type.
        envVariables: ["ORDERS_QUEUE_URL"],
      }),
    ).toThrow();
  });
});

describe("the graphql metadata namespace", () => {
  it("round-trips what a writer sets", () => {
    const metadata = withGraphqlMetadata(
      { codeScope: { kind: "codeUri", path: "src/resolvers/" } },
      {
        rootType: "Query",
        fieldName: "user",
        document: "query GetUser { user { id } }",
      },
    );
    const read = readGraphqlMetadata(summaryWith(metadata));
    expect(read?.rootType).toBe("Query");
    expect(read?.fieldName).toBe("user");
    expect(read?.document).toBe("query GetUser { user { id } }");
    // Neighboring namespaces survive the merge.
    expect(metadata.codeScope).toEqual({
      kind: "codeUri",
      path: "src/resolvers/",
    });
  });

  it("answers undefined when the namespace is absent or not an object", () => {
    expect(readGraphqlMetadata(summaryWith(undefined))).toBeUndefined();
    expect(readGraphqlMetadata(summaryWith({ graphql: 42 }))).toBeUndefined();
  });

  it("drops a field that does not parse and keeps its siblings", () => {
    const read = readGraphqlMetadata(
      summaryWith({
        graphql: {
          document: "query GetUser { user { id } }",
          rootType: "Query",
          declaredContract: {
            // Missing `returnType` — the whole nested field fails to
            // parse and drops, while `document` and `rootType` survive.
            args: [],
            provenance: "derived",
          },
        },
      }),
    );
    expect(read?.document).toBe("query GetUser { user { id } }");
    expect(read?.rootType).toBe("Query");
    expect(read?.declaredContract).toBeUndefined();
  });

  it("refuses a value the schema does not name at write time", () => {
    expect(() =>
      withGraphqlMetadata(undefined, {
        // @ts-expect-error a renamed field fails to compile; the parse
        // catches a caller that casts around the type.
        fieldname: "user",
      }),
    ).toThrow();
  });
});
