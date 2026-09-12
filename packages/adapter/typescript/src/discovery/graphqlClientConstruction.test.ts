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
      fragmentRegistry: {
        cacheProperty: "cache",
        cacheConstructor: {
          importModule: "@apollo/client",
          importName: "InMemoryCache",
        },
        registryProperty: "fragments",
      },
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

/** An operation whose shipped document spreads a fragment nothing defines. */
function danglingSpreadSummary(): BehavioralSummary {
  const summary = operationSummary();
  summary.metadata = {
    graphql: {
      document: "query GetPet { pet { ...PetFields } }",
      unresolvedFragments: ["PetFields"],
    },
  };
  return summary;
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

  it("routes operations by file scope when the project uses two clients", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { ApolloClient } from "@apollo/client";
      export const a = new ApolloClient({ uri: "https://one.example.com" });
      export const b = new ApolloClient({ uri: "https://two.example.com" });
    `,
    );
    const scopedPack: PatternPack = {
      ...clientPack,
      graphqlOperationScopes: [
        { files: ["src/admin/**"], workspace: "nextgen" },
        { files: ["src/**"], workspace: "rails-app" },
      ],
    };
    const adminOp = {
      ...operationSummary(),
      location: {
        file: "/repo/src/admin/useDeleteUser.ts",
        range: { start: 1, end: 10 },
        exportName: "useDeleteUser",
      },
    };
    const memberOp = {
      ...operationSummary(),
      location: {
        file: "/repo/src/feed/usePosts.ts",
        range: { start: 1, end: 10 },
        exportName: "usePosts",
      },
    };
    stampGraphqlClientRefs(
      [adminOp, memberOp],
      [file],
      [scopedPack],
      undefined,
    );
    expect(readGraphqlMetadata(adminOp)?.client?.workspace).toBe("nextgen");
    expect(readGraphqlMetadata(memberOp)?.client?.workspace).toBe("rails-app");
  });

  it("lets a file scope override the sole client's binding", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { ApolloClient } from "@apollo/client";
      export const client = new ApolloClient({ uri: "https://one.example.com" });
    `,
    );
    const scopedPack: PatternPack = {
      ...clientPack,
      graphqlClientBindings: { "https://one.example.com": "rails-app" },
      graphqlOperationScopes: [
        { files: ["src/admin/**"], workspace: "nextgen" },
      ],
    };
    const adminOp = {
      ...operationSummary(),
      location: {
        file: "/repo/src/admin/useDeleteUser.ts",
        range: { start: 1, end: 10 },
        exportName: "useDeleteUser",
      },
    };
    const memberOp = operationSummary();
    stampGraphqlClientRefs(
      [adminOp, memberOp],
      [file],
      [scopedPack],
      undefined,
    );
    expect(readGraphqlMetadata(adminOp)?.client?.workspace).toBe("nextgen");
    expect(readGraphqlMetadata(memberOp)?.client?.workspace).toBe("rails-app");
  });

  it("stamps fragmentRegistry absent when every construction reads registry-free", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { ApolloClient, InMemoryCache } from "@apollo/client";
      export const client = new ApolloClient({
        uri: "https://api.example.com/graphql",
        cache: new InMemoryCache({ typePolicies: {} }),
      });
    `,
    );
    const summary = danglingSpreadSummary();
    stampGraphqlClientRefs([summary], [file], [clientPack], undefined);
    expect(readGraphqlMetadata(summary)?.fragmentRegistry).toBe("absent");
  });

  it("reads a cache bound to a local and passed as shorthand", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { ApolloClient, InMemoryCache } from "@apollo/client";
      const cache = new InMemoryCache();
      export const client = new ApolloClient({
        uri: "https://api.example.com/graphql",
        cache,
      });
    `,
    );
    const summary = danglingSpreadSummary();
    stampGraphqlClientRefs([summary], [file], [clientPack], undefined);
    expect(readGraphqlMetadata(summary)?.fragmentRegistry).toBe("absent");
  });

  it("stamps fragmentRegistry configured when the cache installs one", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { ApolloClient, InMemoryCache } from "@apollo/client";
      import { createFragmentRegistry } from "@apollo/client/cache";
      import { gql } from "@apollo/client";
      export const client = new ApolloClient({
        uri: "https://api.example.com/graphql",
        cache: new InMemoryCache({
          fragments: createFragmentRegistry(gql\`fragment Invoice on Invoice { id }\`),
        }),
      });
    `,
    );
    const summary = danglingSpreadSummary();
    stampGraphqlClientRefs([summary], [file], [clientPack], undefined);
    expect(readGraphqlMetadata(summary)?.fragmentRegistry).toBe("configured");
  });

  it("stamps fragmentRegistry unknown when no construction is in the read set", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/page.ts",
      "export const nothing = 1;",
    );
    const summary = danglingSpreadSummary();
    stampGraphqlClientRefs([summary], [file], [clientPack], undefined);
    expect(readGraphqlMetadata(summary)?.fragmentRegistry).toBe("unknown");
  });

  it("stamps fragmentRegistry unknown when a helper builds the cache", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { ApolloClient } from "@apollo/client";
      import { buildCache } from "./cache-factory";
      export const client = new ApolloClient({
        uri: "https://api.example.com/graphql",
        cache: buildCache(),
      });
    `,
    );
    const summary = danglingSpreadSummary();
    stampGraphqlClientRefs([summary], [file], [clientPack], undefined);
    expect(readGraphqlMetadata(summary)?.fragmentRegistry).toBe("unknown");
  });

  it("stamps fragmentRegistry unknown when the cache options contain a spread", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { ApolloClient, InMemoryCache } from "@apollo/client";
      import { baseOptions } from "./cache-options";
      export const client = new ApolloClient({
        uri: "https://api.example.com/graphql",
        cache: new InMemoryCache({ ...baseOptions }),
      });
    `,
    );
    const summary = danglingSpreadSummary();
    stampGraphqlClientRefs([summary], [file], [clientPack], undefined);
    expect(readGraphqlMetadata(summary)?.fragmentRegistry).toBe("unknown");
  });

  it("lets one configured construction outweigh registry-free ones", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "src/client.ts",
      `
      import { ApolloClient, InMemoryCache } from "@apollo/client";
      import { createFragmentRegistry } from "@apollo/client/cache";
      import { gql } from "@apollo/client";
      export const plain = new ApolloClient({
        uri: "https://one.example.com",
        cache: new InMemoryCache(),
      });
      export const registered = new ApolloClient({
        uri: "https://two.example.com",
        cache: new InMemoryCache({
          fragments: createFragmentRegistry(gql\`fragment F on T { id }\`),
        }),
      });
    `,
    );
    const summary = danglingSpreadSummary();
    stampGraphqlClientRefs([summary], [file], [clientPack], undefined);
    expect(readGraphqlMetadata(summary)?.fragmentRegistry).toBe("configured");
  });

  it("leaves fragmentRegistry off an operation with no dangling spread", () => {
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
    const summary = operationSummary();
    stampGraphqlClientRefs([summary], [file], [clientPack], undefined);
    expect(readGraphqlMetadata(summary)?.fragmentRegistry).toBeUndefined();
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
