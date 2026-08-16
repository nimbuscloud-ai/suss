import { describe, expect, it } from "vitest";

import {
  type BehavioralSummary,
  graphqlOperationBinding,
  readGraphqlMetadata,
} from "@suss/behavioral-ir";
import { createTestProject } from "@suss/test-project";

import {
  collectGraphqlClientRefs,
  soleGraphqlClientRef,
  stampGraphqlClientRefs,
} from "./graphqlClientConstruction.js";

import type { PatternPack } from "@suss/extractor";

const clientPack: PatternPack = {
  name: "apollo-client",
  protocol: "http",
  languages: ["typescript"],
  discovery: [],
  terminals: [],
  inputMapping: { type: "positionalParams", params: [] },
  graphqlClients: [
    {
      importModule: "@apollo/client",
      importName: "ApolloClient",
      uriProperty: "uri",
    },
    {
      importModule: "@apollo/client",
      importName: "HttpLink",
      uriProperty: "uri",
    },
    {
      importModule: "@apollo/client",
      importName: "createHttpLink",
      uriProperty: "uri",
    },
  ],
};

function operationSummary(): BehavioralSummary {
  return {
    kind: "client",
    location: {
      file: "src/usePet.ts",
      range: { start: 1, end: 10 },
      exportName: "usePet",
    },
    identity: {
      name: "usePet.GetPet",
      exportPath: ["usePet"],
      boundaryBinding: graphqlOperationBinding({
        transport: "http",
        recognition: "apollo-client",
        operationType: "query",
        operationName: "GetPet",
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    metadata: { graphql: { document: "query GetPet { pet { id } }" } },
  };
}

describe("collectGraphqlClientRefs", () => {
  it("reads a literal uri off an ApolloClient construction", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { ApolloClient, InMemoryCache } from "@apollo/client";
      export const client = new ApolloClient({
        uri: "https://api.example.com/graphql",
        cache: new InMemoryCache(),
      });
    `,
    );
    const refs = collectGraphqlClientRefs([file], [clientPack], undefined);
    expect(refs).toEqual([
      { uri: "https://api.example.com/graphql", uriRef: null },
    ]);
  });

  it("records a computed uri as the written expression", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { ApolloClient } from "@apollo/client";
      export const client = new ApolloClient({
        uri: import.meta.env.VITE_GRAPHQL_URL,
      });
    `,
    );
    const refs = collectGraphqlClientRefs([file], [clientPack], undefined);
    expect(refs).toEqual([
      { uri: null, uriRef: "import.meta.env.VITE_GRAPHQL_URL" },
    ]);
  });

  it("reads the createHttpLink factory and an aliased import", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { createHttpLink as makeLink } from "@apollo/client";
      export const link = makeLink({ uri: "https://api.example.com/graphql" });
    `,
    );
    const refs = collectGraphqlClientRefs([file], [clientPack], undefined);
    expect(refs).toEqual([
      { uri: "https://api.example.com/graphql", uriRef: null },
    ]);
  });
});

describe("soleGraphqlClientRef", () => {
  it("collapses constructions that agree on one endpoint", () => {
    const sole = soleGraphqlClientRef([
      { uri: "https://api.example.com/graphql", uriRef: null },
      { uri: "https://api.example.com/graphql", uriRef: null },
    ]);
    expect(sole).toEqual({
      uri: "https://api.example.com/graphql",
      uriRef: null,
    });
  });

  it("abstains when two distinct endpoints exist", () => {
    const sole = soleGraphqlClientRef([
      { uri: "https://api.example.com/graphql", uriRef: null },
      { uri: null, uriRef: "process.env.OTHER_URL" },
    ]);
    expect(sole).toBeNull();
  });

  it("abstains when nothing was constructed", () => {
    expect(soleGraphqlClientRef([])).toBeNull();
  });
});

describe("stampGraphqlClientRefs", () => {
  it("stamps the sole client on every graphql-operation summary", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { ApolloClient } from "@apollo/client";
      export const client = new ApolloClient({
        uri: "https://api.example.com/graphql",
      });
    `,
    );
    const summary = operationSummary();
    stampGraphqlClientRefs([summary], [file], [clientPack], undefined);
    expect(readGraphqlMetadata(summary)?.client).toEqual({
      uri: "https://api.example.com/graphql",
      uriRef: null,
    });
    expect(readGraphqlMetadata(summary)?.document).toContain("GetPet");
  });

  it("adds the bound workspace when pack config grounds the endpoint", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { ApolloClient } from "@apollo/client";
      export const client = new ApolloClient({
        uri: import.meta.env.VITE_GRAPHQL_URL,
      });
    `,
    );
    const boundPack: PatternPack = {
      ...clientPack,
      graphqlClientBindings: {
        "import.meta.env.VITE_GRAPHQL_URL": "appsync-stack",
      },
    };
    const summary = operationSummary();
    stampGraphqlClientRefs([summary], [file], [boundPack], undefined);
    expect(readGraphqlMetadata(summary)?.client).toEqual({
      uri: null,
      uriRef: "import.meta.env.VITE_GRAPHQL_URL",
      workspace: "appsync-stack",
    });
  });

  it("leaves the workspace off when no binding matches the endpoint", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { ApolloClient } from "@apollo/client";
      export const client = new ApolloClient({ uri: "https://api.example.com" });
    `,
    );
    const boundPack: PatternPack = {
      ...clientPack,
      graphqlClientBindings: { "https://elsewhere.example.com": "other" },
    };
    const summary = operationSummary();
    stampGraphqlClientRefs([summary], [file], [boundPack], undefined);
    expect(readGraphqlMetadata(summary)?.client).toEqual({
      uri: "https://api.example.com",
      uriRef: null,
    });
  });

  it("leaves summaries alone when two clients exist", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { ApolloClient } from "@apollo/client";
      export const a = new ApolloClient({ uri: "https://one.example.com" });
      export const b = new ApolloClient({ uri: "https://two.example.com" });
    `,
    );
    const summary = operationSummary();
    stampGraphqlClientRefs([summary], [file], [clientPack], undefined);
    expect(readGraphqlMetadata(summary)?.client).toBeUndefined();
  });
});
