import { describe, expect, it } from "vitest";

import {
  readCodeScopeMetadata,
  readGraphqlMetadata,
  readHttpMetadata,
  readLibraryEnvReads,
  readMessageBusMetadata,
  readMetricContractMetadata,
  readMetricReadingMetadata,
  readModuleImports,
  readReactMetadata,
  readRoutingMetadata,
  readRuntimeContractMetadata,
  readSourceDocumentMetadata,
  readStorageContractMetadata,
  readStorybookMetadata,
  withGraphqlMetadata,
  withHttpMetadata,
  withMessageBusMetadata,
  withRoutingMetadata,
  withRuntimeContractMetadata,
  withSourceDocumentMetadata,
} from "./index.js";

import type { BehavioralSummary, Transition } from "./index.js";

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

function transitionWith(
  metadata: Record<string, unknown> | undefined,
): Transition {
  return {
    id: "t-2xx",
    conditions: [],
    output: { type: "response", statusCode: null, body: null, headers: {} },
    effects: [],
    location: { start: 0, end: 0 },
    isDefault: false,
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

describe("the routing metadata namespace", () => {
  it("round-trips what a writer sets", () => {
    const metadata = withRoutingMetadata(undefined, {
      edge: "routesTo",
      router: "ShopHttpsListener",
      target: "OrdersTargetGroup",
      matchId: "OrdersListenerRule",
      priority: 10,
      conditions: [
        { field: "path-pattern", values: ["/api/orders/*"], evaluated: true },
      ],
    });
    const read = readRoutingMetadata(summaryWith(metadata));
    expect(read?.edge).toBe("routesTo");
    expect(read?.target).toBe("OrdersTargetGroup");
    expect(read?.priority).toBe(10);
    expect(read?.conditions).toEqual([
      { field: "path-pattern", values: ["/api/orders/*"], evaluated: true },
    ]);
  });

  it("answers undefined when the namespace is absent or not an object", () => {
    expect(readRoutingMetadata(summaryWith(undefined))).toBeUndefined();
    expect(readRoutingMetadata(summaryWith({ routing: 42 }))).toBeUndefined();
  });

  it("drops a field that does not parse and keeps its siblings", () => {
    const read = readRoutingMetadata(
      summaryWith({
        routing: {
          edge: "fronts",
          target: "OrdersTargetGroup",
          resource: 42,
        },
      }),
    );
    expect(read?.edge).toBe("fronts");
    expect(read?.target).toBe("OrdersTargetGroup");
    expect(read?.resource).toBeUndefined();
  });

  it("refuses a value the schema does not name at write time", () => {
    expect(() =>
      withRoutingMetadata(undefined, {
        edge: "fronts",
        target: "OrdersTargetGroup",
        // @ts-expect-error a renamed field fails to compile; the parse
        // catches a caller that casts around the type.
        backedBy: "OrdersTaskDefinition/orders-app",
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
            // `returnType` is missing, so the whole nested field fails
            // to parse and drops, while `document` and `rootType` stay.
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

describe("the sourceDocument metadata namespace", () => {
  it("round-trips the label a reader sets", () => {
    const metadata = withSourceDocumentMetadata(
      { graphql: { rootType: "Query" } },
      { label: "services/api/schema.graphql" },
    );
    expect(readSourceDocumentMetadata(summaryWith(metadata))?.label).toBe(
      "services/api/schema.graphql",
    );
    expect(metadata.graphql).toEqual({ rootType: "Query" });
  });

  it("reads nothing when the namespace is absent or has no label", () => {
    expect(readSourceDocumentMetadata(summaryWith(undefined))).toBeUndefined();
    expect(
      readSourceDocumentMetadata(summaryWith({ sourceDocument: {} })),
    ).toBeUndefined();
    expect(
      readSourceDocumentMetadata(summaryWith({ sourceDocument: 42 })),
    ).toBeUndefined();
  });
});

describe("the http metadata namespace", () => {
  it("round-trips what a writer sets on a summary", () => {
    const metadata = withHttpMetadata(
      { codeScope: { kind: "codeUri", path: "src/handlers/" } },
      {
        declaredContract: {
          framework: "openapi",
          provenance: "derived",
          responses: [{ statusCode: 200 }, { statusCode: 404 }],
        },
        bodyAccessors: ["data"],
      },
    );
    const read = readHttpMetadata(summaryWith(metadata));
    expect(read?.declaredContract?.responses).toEqual([
      { statusCode: 200 },
      { statusCode: 404 },
    ]);
    expect(read?.bodyAccessors).toEqual(["data"]);
    // Neighboring namespaces survive the merge.
    expect(metadata.codeScope).toEqual({
      kind: "codeUri",
      path: "src/handlers/",
    });
  });

  it("round-trips what a writer sets on a transition, not just a summary", () => {
    // statusRange describes one response, so a range-coded OpenAPI
    // operation writes it on the transition itself rather than the
    // summary. One reader handles both.
    const metadata = withHttpMetadata(undefined, {
      statusRange: { min: 200, max: 299, spec: "2XX" },
    });
    const read = readHttpMetadata(transitionWith(metadata));
    expect(read?.statusRange).toEqual({ min: 200, max: 299, spec: "2XX" });
  });

  it("defaults declaredContract.provenance to independent when a writer omits it", () => {
    const read = readHttpMetadata(
      summaryWith({
        http: {
          declaredContract: {
            framework: "apigateway",
            responses: [{ statusCode: 200 }],
          },
        },
      }),
    );
    expect(read?.declaredContract?.provenance).toBe("independent");
  });

  it("still answers responses when a writer omits framework", () => {
    // A writer that leaves framework unset shouldn't lose the whole
    // contract to the field-level drop; framework is informational,
    // not required to trust the responses it lists.
    const read = readHttpMetadata(
      summaryWith({
        http: {
          declaredContract: { responses: [{ statusCode: 200 }] },
        },
      }),
    );
    expect(read?.declaredContract?.responses).toEqual([{ statusCode: 200 }]);
    expect(read?.declaredContract?.framework).toBeUndefined();
  });

  it("answers undefined when the namespace is absent or not an object", () => {
    expect(readHttpMetadata(summaryWith(undefined))).toBeUndefined();
    expect(readHttpMetadata(summaryWith({ http: 42 }))).toBeUndefined();
  });

  it("drops a field that does not parse and keeps its siblings", () => {
    const read = readHttpMetadata(
      summaryWith({
        http: {
          bodyAccessors: ["data"],
          declaredContract: { framework: "cfn", responses: "not-an-array" },
        },
      }),
    );
    expect(read?.bodyAccessors).toEqual(["data"]);
    expect(read?.declaredContract).toBeUndefined();
  });

  it("refuses a value the schema does not name at write time", () => {
    expect(() =>
      withHttpMetadata(undefined, {
        // @ts-expect-error a renamed field fails to compile; the parse
        // catches a caller that casts around the type.
        declaredResponses: [{ statusCode: 200 }],
      }),
    ).toThrow();
  });
});

describe("readModuleImports", () => {
  it("returns the recorded file list and refuses other shapes", () => {
    expect(
      readModuleImports(summaryWith({ moduleImports: ["src/helper.ts"] })),
    ).toEqual(["src/helper.ts"]);
    expect(readModuleImports(summaryWith(undefined))).toBeUndefined();
    expect(
      readModuleImports(summaryWith({ moduleImports: "src/helper.ts" })),
    ).toBeUndefined();
  });
});

describe("readLibraryEnvReads", () => {
  it("returns the declaration and refuses other shapes", () => {
    expect(
      readLibraryEnvReads(
        summaryWith({
          libraryEnvReads: {
            module: "@aws-lambda-powertools/",
            prefixes: ["POWERTOOLS_"],
          },
        }),
      ),
    ).toEqual({ module: "@aws-lambda-powertools/", prefixes: ["POWERTOOLS_"] });
    expect(
      readLibraryEnvReads(summaryWith({ libraryEnvReads: "POWERTOOLS_" })),
    ).toBeUndefined();
  });
});

describe("typed metadata namespaces", () => {
  const carrier = (metadata: Record<string, unknown>): BehavioralSummary =>
    ({
      kind: "library",
      location: { file: "a.ts", range: { start: 1, end: 2 }, exportName: null },
      identity: { name: "x", exportPath: null, boundaryBinding: null },
      inputs: [],
      transitions: [],
      gaps: [],
      confidence: { source: "declared", level: "high" },
      metadata,
    }) as BehavioralSummary;

  it("reads a storage contract and refuses a misspelled key", () => {
    expect(
      readStorageContractMetadata(
        carrier({ storageContract: { fields: [{ name: "id" }] } }),
      ),
    ).toEqual({ fields: [{ name: "id" }] });
    // A writer that renames the namespace stops being read, rather
    // than handing back a cast that quietly says nothing.
    expect(
      readStorageContractMetadata(
        carrier({ storage_contract: { fields: [{ name: "id" }] } }),
      ),
    ).toBeUndefined();
  });

  it("reads what a metric measures and what a reading needs", () => {
    expect(
      readMetricContractMetadata(
        carrier({
          metricContract: { values: "histogram", accumulates: "gauge" },
        }),
      ),
    ).toEqual({ values: "histogram", accumulates: "gauge" });
    expect(
      readMetricReadingMetadata(
        carrier({
          metricReading: {
            comparesTo: "number",
            reduction: { setting: "reducer", leaves: { MEDIAN: "number" } },
          },
        }),
      ),
    ).toEqual({
      comparesTo: "number",
      reduction: { setting: "reducer", leaves: { MEDIAN: "number" } },
    });
  });

  it("drops a metric field written as a word neither side has", () => {
    expect(
      readMetricContractMetadata(
        carrier({ metricContract: { values: "DISTRIBUTION" } }),
      ),
    ).toEqual({});
    expect(readMetricReadingMetadata(carrier({}))).toBeUndefined();
  });

  it("reads a code scope and a react sub-unit", () => {
    expect(
      readCodeScopeMetadata(
        carrier({ codeScope: { kind: "codeUri", path: "src" } }),
      ),
    ).toEqual({ kind: "codeUri", path: "src" });
    expect(
      readReactMetadata(carrier({ react: { kind: "effect", deps: ["id"] } })),
    ).toEqual({ kind: "effect", deps: ["id"] });
  });

  it("reads a story off the component namespace", () => {
    expect(
      readStorybookMetadata(
        carrier({
          component: { storybook: { story: "Primary", component: "Button" } },
        }),
      ),
    ).toEqual({ story: "Primary", component: "Button" });
    expect(readStorybookMetadata(carrier({ component: {} }))).toBeUndefined();
  });
});
