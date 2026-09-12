import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { readGraphqlMetadata } from "@suss/behavioral-ir";
import { createFixtureProject, createTestProject } from "@suss/test-project";

import { apolloClientPack } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const fixturesDir = path.resolve(
  __dirname,
  "../../../../fixtures/apollo-client",
);

async function runAdapter(): Promise<BehavioralSummary[]> {
  const project = createFixtureProject(fixturesDir, "*.tsx");
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [apolloClientPack()],
  });
  return await adapter.extractAll();
}

// Codegen client-preset layout: the component imports its documents
// from a generated module + a shared operations module. Both the
// generated `.ts` and the consumer `.tsx` must be in the project so the
// adapter can resolve the cross-module import to its declaration.
async function runCodegenAdapter(): Promise<BehavioralSummary[]> {
  const codegenDir = path.join(fixturesDir, "codegen");
  const project = createFixtureProject(codegenDir, "**/*.ts");
  project.addSourceFilesAtPaths(path.join(codegenDir, "**/*.tsx"));
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [apolloClientPack()],
  });
  return await adapter.extractAll();
}

async function runInMemory(source: string): Promise<BehavioralSummary[]> {
  return await runInMemoryFiles({ "consumer.ts": source });
}

async function runInMemoryFiles(
  files: Record<string, string>,
): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  for (const [name, source] of Object.entries(files)) {
    project.createSourceFile(name, source);
  }
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [apolloClientPack()],
  });
  return await adapter.extractAll();
}

// ---------------------------------------------------------------------------
// Pack shape
// ---------------------------------------------------------------------------

describe("apolloClientPack — pack shape", () => {
  const pack = apolloClientPack();

  it("declares the apollo-client identity on http transport", async () => {
    expect(pack.name).toBe("apollo-client");
    expect(pack.protocol).toBe("http");
  });

  it("discovers via both @apollo/client and @apollo/client/react module paths", async () => {
    const modules = pack.discovery
      .map((d) =>
        d.match.type === "graphqlHookCall" ? d.match.importModule : null,
      )
      .filter((m): m is string => m !== null);
    expect(modules).toEqual(["@apollo/client", "@apollo/client/react"]);
  });

  it("targets the three canonical hooks", async () => {
    const hooks = pack.discovery.flatMap((d) =>
      d.match.type === "graphqlHookCall"
        ? d.match.hooks.map((h) => h.hookName)
        : [],
    );
    expect(hooks).toContain("useQuery");
    expect(hooks).toContain("useMutation");
    expect(hooks).toContain("useSubscription");
  });
});

// ---------------------------------------------------------------------------
// Fixture integration
// ---------------------------------------------------------------------------

describe("apolloClientPack — client bindings", () => {
  it("passes the per-project client bindings through to the pack", () => {
    const pack = apolloClientPack({
      clients: { "import.meta.env.VITE_GRAPHQL_URL": "appsync-stack" },
    });
    expect(pack.graphqlClientBindings).toEqual({
      "import.meta.env.VITE_GRAPHQL_URL": "appsync-stack",
    });
  });

  it("leaves the bindings off when the options do not set them", () => {
    expect(apolloClientPack().graphqlClientBindings).toBeUndefined();
    expect(apolloClientPack().graphqlOperationScopes).toBeUndefined();
  });

  it("passes the operation scopes through to the pack", () => {
    const pack = apolloClientPack({
      operationScopes: [{ files: ["src/admin/**"], workspace: "nextgen" }],
    });
    expect(pack.graphqlOperationScopes).toEqual([
      { files: ["src/admin/**"], workspace: "nextgen" },
    ]);
  });
});

describe("apolloClientPack — integration", () => {
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await runAdapter();
  }, 90_000);

  it("discovers one client summary per hook or imperative call", async () => {
    // Hooks: usePet, useCreatePet, useAnonPing, useTicks, plus
    // useUserFromFile (.graphql import) and useOwner (interpolated
    // fragment). Imperative: loadPetById, createPetImperative.
    expect(summaries).toHaveLength(8);
    for (const s of summaries) {
      expect(s.kind).toBe("client");
    }
  });

  it("binds a named query to graphql-operation(query, GetPet)", async () => {
    const getPet = summaries.find((s) => s.identity.name === "usePet.GetPet");
    expect(getPet).toBeDefined();
    expect(getPet?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: {
        name: "graphql-operation",
        operationType: "query",
        operationName: "GetPet",
      },
      recognition: "apollo-client",
    });
  });

  it("resolves gql through a const binding (GET_PET identifier, not inline)", async () => {
    // The fixture declares `const GET_PET = gql\`query GetPet ...\``
    // and calls `useQuery(GET_PET, ...)`. Discovery has to follow
    // the identifier to the declaration to read the operation name.
    const getPet = summaries.find((s) => s.identity.name === "usePet.GetPet");
    const sem = getPet?.identity.boundaryBinding?.semantics;
    expect(sem?.name === "graphql-operation" ? sem.operationName : null).toBe(
      "GetPet",
    );
  });

  it("reads a document composed from an interpolated fragment", async () => {
    const owner = summaries.find(
      (s) => s.identity.name === "useOwner.GetOwner",
    );
    expect(owner).toBeDefined();
    const graphql = owner && readGraphqlMetadata(owner);
    expect(graphql?.document).toContain("fragment OwnerFields on Owner");
    expect(graphql?.unresolvedFragments).toBeUndefined();
  });

  it("handles inline gql`...` arguments (useMutation(gql`...`))", async () => {
    const createPet = summaries.find(
      (s) => s.identity.name === "useCreatePet.CreatePet",
    );
    expect(createPet).toBeDefined();
    const sem = createPet?.identity.boundaryBinding?.semantics;
    expect(sem?.name).toBe("graphql-operation");
    if (sem?.name === "graphql-operation") {
      expect(sem.operationType).toBe("mutation");
      expect(sem.operationName).toBe("CreatePet");
    }
  });

  it("handles anonymous queries — omits operationName, records query type", async () => {
    const anon = summaries.find((s) =>
      s.identity.name.startsWith("useAnonPing."),
    );
    expect(anon).toBeDefined();
    // Name fall-back because the query header has no operation name.
    expect(anon?.identity.name).toBe("useAnonPing.<anon-query>");
    const sem = anon?.identity.boundaryBinding?.semantics;
    expect(sem?.name === "graphql-operation" ? sem.operationType : null).toBe(
      "query",
    );
    if (sem?.name === "graphql-operation") {
      expect(sem.operationName).toBeUndefined();
    }
  });

  it("discovers subscriptions alongside queries and mutations", async () => {
    const tick = summaries.find((s) => s.identity.name === "useTicks.OnTick");
    const sem = tick?.identity.boundaryBinding?.semantics;
    expect(sem?.name === "graphql-operation" ? sem.operationType : null).toBe(
      "subscription",
    );
  });

  it("respects import aliases (useMutation as useApolloMutation)", async () => {
    // The fixture imports useMutation under an alias. Discovery
    // walks the aliased local name while keeping canonical hook
    // identity for provenance.
    const createPet = summaries.find(
      (s) => s.identity.name === "useCreatePet.CreatePet",
    );
    expect(createPet).toBeDefined();
  });

  it("surfaces operation header variables as Input[] with role 'variable'", async () => {
    // `GET_PET` is declared as `query GetPet($id: ID!) { ... }`,
    // the `$id: ID!` variable should show up as a summary input
    // with a non-null ref type. Same machinery powers future
    // resolver-arg pairing.
    const getPet = summaries.find((s) => s.identity.name === "usePet.GetPet");
    expect(getPet?.inputs).toHaveLength(1);
    const input = getPet?.inputs[0];
    expect(input?.type).toBe("parameter");
    if (input?.type === "parameter") {
      expect(input.name).toBe("id");
      expect(input.role).toBe("variable");
      expect(input.shape).toEqual({ type: "ref", name: "ID!" });
    }
  });

  it("handles multi-variable mutations", async () => {
    // `CreatePet` takes `$name: String!`, one required variable.
    const create = summaries.find(
      (s) => s.identity.name === "useCreatePet.CreatePet",
    );
    const names = create?.inputs
      .filter((i) => i.type === "parameter")
      .map((i) => (i.type === "parameter" ? i.name : ""))
      .sort();
    expect(names).toEqual(["name"]);
  });

  it("emits empty inputs for operations with no variables", async () => {
    const anon = summaries.find((s) =>
      s.identity.name.startsWith("useAnonPing."),
    );
    expect(anon?.inputs).toEqual([]);
  });

  it("discovers imperative client.query calls", async () => {
    const imperativeQuery = summaries.find(
      (s) => s.identity.name === "loadPetById.LoadPet",
    );
    expect(imperativeQuery).toBeDefined();
    expect(imperativeQuery?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: {
        name: "graphql-operation",
        operationType: "query",
        operationName: "LoadPet",
      },
      recognition: "apollo-client",
    });
  });

  it("discovers imperative client.mutate calls", async () => {
    const imperativeMutation = summaries.find(
      (s) => s.identity.name === "createPetImperative.CreatePetImperative",
    );
    expect(imperativeMutation).toBeDefined();
    const sem = imperativeMutation?.identity.boundaryBinding?.semantics;
    expect(sem?.name).toBe("graphql-operation");
    if (sem?.name === "graphql-operation") {
      expect(sem.operationType).toBe("mutation");
    }
  });

  it("resolves `.graphql` file imports and extracts operation info", async () => {
    // `useUserFromFile` passes GET_USER_FILE which is imported from
    // `./queries/GetUserFile.graphql`. Discovery reads the file,
    // parses its header, and emits a normal operation summary.
    const fromFile = summaries.find(
      (s) => s.identity.name === "useUserFromFile.GetUserFile",
    );
    expect(fromFile).toBeDefined();
    const sem = fromFile?.identity.boundaryBinding?.semantics;
    expect(sem?.name === "graphql-operation" ? sem.operationName : null).toBe(
      "GetUserFile",
    );
    // Variables from the .graphql file surface as inputs.
    const idInput = fromFile?.inputs.find(
      (i) => i.type === "parameter" && i.name === "id",
    );
    expect(idInput).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Codegen client-preset: cross-module document resolution
// ---------------------------------------------------------------------------

describe("apolloClientPack — codegen client-preset", () => {
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await runCodegenAdapter();
  }, 90_000);

  it("discovers one summary per hook call across the module boundary", async () => {
    // usePetList (generated TypedDocumentNode object), useAdoptPet
    // (generated document with an unreadable body), useTags (gql const
    // exported from another module).
    expect(summaries).toHaveLength(3);
    for (const s of summaries) {
      expect(s.kind).toBe("client");
    }
  });

  it("resolves a generated TypedDocumentNode imported from the generated module", async () => {
    const petList = summaries.find(
      (s) => s.identity.name === "usePetList.GetPets",
    );
    expect(petList).toBeDefined();
    expect(petList?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: {
        name: "graphql-operation",
        operationType: "query",
        operationName: "GetPets",
      },
      recognition: "apollo-client",
    });
  });

  it("extracts operation-header variables from the generated document", async () => {
    const petList = summaries.find(
      (s) => s.identity.name === "usePetList.GetPets",
    );
    const first = petList?.inputs.find(
      (i) => i.type === "parameter" && i.name === "first",
    );
    expect(first).toBeDefined();
    if (first?.type === "parameter") {
      expect(first.role).toBe("variable");
      // Optional `$first: Int`: nullable ref, no `!` suffix.
      expect(first.shape).toEqual({ type: "ref", name: "Int" });
    }
  });

  it("resolves a gql-tagged const exported from another module", async () => {
    const tags = summaries.find((s) => s.identity.name === "useTags.ListTags");
    expect(tags).toBeDefined();
    const sem = tags?.identity.boundaryBinding?.semantics;
    expect(sem?.name === "graphql-operation" ? sem.operationName : null).toBe(
      "ListTags",
    );
  });

  it("falls back to TypedDocumentNode type arguments when the body isn't readable", async () => {
    // `AdoptPetDocument` is `buildDocument(...) as unknown as
    // TypedDocumentNode<AdoptPetMutation, AdoptPetMutationVariables>`,
    // the object body can't be read, so the header comes from the
    // result type argument's `<Name><Kind>` name.
    const adopt = summaries.find(
      (s) => s.identity.name === "useAdoptPet.AdoptPet",
    );
    expect(adopt).toBeDefined();
    const sem = adopt?.identity.boundaryBinding?.semantics;
    expect(sem?.name).toBe("graphql-operation");
    if (sem?.name === "graphql-operation") {
      expect(sem.operationType).toBe("mutation");
      expect(sem.operationName).toBe("AdoptPet");
    }
  });

  it("surfaces the unreadable document as an explicit gap, never dropping the boundary", async () => {
    const adopt = summaries.find(
      (s) => s.identity.name === "useAdoptPet.AdoptPet",
    );
    const graphqlMeta = adopt && readGraphqlMetadata(adopt);
    expect(graphqlMeta?.unresolvedDocument?.reference).toBe("AdoptPetDocument");
    expect(graphqlMeta?.unresolvedDocument?.reason).toContain("type arguments");
    // No document body carried through, the checker's pairing layer
    // reads that field and degrades rather than parsing an empty doc.
    expect(graphqlMeta?.document).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases via in-memory projects
// ---------------------------------------------------------------------------

describe("apolloClientPack — which object is the client", () => {
  it("leaves an unrelated object with a query method alone", async () => {
    // db is a query builder, a repository, anything. A boundary
    // claimed for it pairs against a GraphQL server the code never
    // calls, so the gate is on the receiver rather than on the file's
    // imports.
    const summaries = await runInMemory(`
      import { ApolloClient, gql } from "@apollo/client";
      const GetUser = gql\`query GetUser { user { id } }\`;
      const db: any = {};
      export async function load() { return db.query({ query: GetUser }); }
    `);
    expect(summaries).toEqual([]);
  });

  it("follows a client built in the same file with new", async () => {
    const summaries = await runInMemory(`
      import { ApolloClient, gql } from "@apollo/client";
      const GetUser = gql\`query GetUser { user { id } }\`;
      const client = new ApolloClient({});
      export async function load() { return client.query({ query: GetUser }); }
    `);
    const semantics = summaries[0]?.identity.boundaryBinding?.semantics as
      | { operationName?: string }
      | undefined;
    expect(semantics?.operationName).toBe("GetUser");
  });

  it("follows a client imported from another file, which the docs recommend", async () => {
    const summaries = await runInMemoryFiles({
      "client.ts": `
        import { ApolloClient } from "@apollo/client";
        export const client = new ApolloClient({});
      `,
      "consumer.ts": `
        import { gql } from "@apollo/client";
        import { client } from "./client.js";
        const GetUser = gql\`query GetUser { user { id } }\`;
        export async function load() { return client.query({ query: GetUser }); }
      `,
    });
    const found = summaries.find((one) => {
      const semantics = one.identity.boundaryBinding?.semantics as
        | { operationName?: string }
        | undefined;
      return semantics?.operationName === "GetUser";
    });
    expect(found?.location.file).toContain("consumer.ts");
  });
});

describe("apolloClientPack — edge cases", () => {
  it("emits nothing when the Apollo import is absent", async () => {
    const summaries = await runInMemory(`
      declare function useQuery(doc: unknown, opts?: unknown): any;
      export function Page() {
        useQuery({ query: "raw" });
      }
    `);
    expect(summaries).toEqual([]);
  });

  it("reports a call whose first argument is not a document as a gap", async () => {
    const summaries = await runInMemory(`
      import { useQuery } from "@apollo/client";
      declare const doc: any;
      export function Page() {
        useQuery(doc);
      }
    `);
    expect(summaries).toHaveLength(1);
    const gap = readGraphqlMetadata(summaries[0])?.unresolvedDocument;
    expect(gap?.reference).toBe("doc");
  });

  it("does not read a tagged template whose tag isn't a document tag", async () => {
    const summaries = await runInMemory(`
      import { useQuery } from "@apollo/client";
      function css(strings: TemplateStringsArray) { return strings[0]; }
      export function Page() {
        useQuery(css\`query GetUser { user { id } }\`);
      }
    `);
    const semantics = summaries[0]?.identity.boundaryBinding?.semantics as
      | { operationName?: string }
      | undefined;
    expect(semantics?.operationName).toBeUndefined();
  });

  it("handles the shorthand `{ ... }` anonymous query", async () => {
    const summaries = await runInMemory(`
      import { gql, useQuery } from "@apollo/client";
      export function Page() {
        useQuery(gql\`{ ping }\`);
      }
    `);
    expect(summaries).toHaveLength(1);
    const sem = summaries[0].identity.boundaryBinding?.semantics;
    expect(sem?.name === "graphql-operation" ? sem.operationType : null).toBe(
      "query",
    );
  });

  it("skips empty-argument hook calls", async () => {
    const summaries = await runInMemory(`
      import { useQuery } from "@apollo/client";
      declare function runHook(): void;
      export function Page() {
        // Calling useQuery with no args is a type error at the
        // Apollo-client level; still, discovery should walk past it
        // without crashing.
        runHook();
      }
    `);
    expect(summaries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fragments interpolated into the document (#461)
// ---------------------------------------------------------------------------

describe("apolloClientPack — interpolated fragments", () => {
  const petFragment = `
    const PET_FIELDS = gql\`
      fragment PetFields on Pet {
        id
        name
        deletedAt
      }
    \`;
  `;

  it("resolves a fragment interpolated after the operation", async () => {
    const summaries = await runInMemory(`
      import { gql, useQuery } from "@apollo/client";
      ${petFragment}
      const GET_PET = gql\`
        query GetPet($id: ID!) {
          pet(id: $id) {
            ...PetFields
          }
        }
        \${PET_FIELDS}
      \`;
      export function usePet(id: string) {
        return useQuery(GET_PET, { variables: { id } });
      }
    `);
    expect(summaries.map((s) => s.identity.name)).toEqual(["usePet.GetPet"]);
    const graphql = readGraphqlMetadata(summaries[0]);
    expect(graphql?.document).toContain("fragment PetFields on Pet");
    expect(graphql?.unresolvedFragments).toBeUndefined();
    expect(graphql?.unresolvedDocument).toBeUndefined();
  });

  it("resolves a fragment interpolated before the operation", async () => {
    const summaries = await runInMemory(`
      import { gql, useQuery } from "@apollo/client";
      ${petFragment}
      const GET_PET = gql\`
        \${PET_FIELDS}
        query GetPet($id: ID!) {
          pet(id: $id) {
            ...PetFields
          }
        }
      \`;
      export function usePet(id: string) {
        return useQuery(GET_PET, { variables: { id } });
      }
    `);
    expect(summaries.map((s) => s.identity.name)).toEqual(["usePet.GetPet"]);
    const graphql = readGraphqlMetadata(summaries[0]);
    expect(graphql?.document).toContain("fragment PetFields on Pet");
    expect(graphql?.unresolvedFragments).toBeUndefined();
  });

  it("resolves a fragment imported from another module", async () => {
    const summaries = await runInMemoryFiles({
      "fragments.ts": `
        import { gql } from "@apollo/client";
        export const PET_FIELDS = gql\`
          fragment PetFields on Pet {
            id
            name
          }
        \`;
      `,
      "consumer.ts": `
        import { gql, useQuery } from "@apollo/client";
        import { PET_FIELDS } from "./fragments";
        const GET_PET = gql\`
          query GetPet {
            pet {
              ...PetFields
            }
          }
          \${PET_FIELDS}
        \`;
        export function usePet() {
          return useQuery(GET_PET);
        }
      `,
    });
    expect(summaries.map((s) => s.identity.name)).toEqual(["usePet.GetPet"]);
    const graphql = readGraphqlMetadata(summaries[0]);
    expect(graphql?.document).toContain("fragment PetFields on Pet");
    expect(graphql?.unresolvedFragments).toBeUndefined();
  });

  it("resolves a fragment that itself interpolates another fragment", async () => {
    const summaries = await runInMemory(`
      import { gql, useQuery } from "@apollo/client";
      const PET_BASE = gql\`
        fragment PetBase on Pet {
          id
        }
      \`;
      const PET_FIELDS = gql\`
        fragment PetFields on Pet {
          ...PetBase
          name
        }
        \${PET_BASE}
      \`;
      const GET_PET = gql\`
        query GetPet {
          pet {
            ...PetFields
          }
        }
        \${PET_FIELDS}
      \`;
      export function usePet() {
        return useQuery(GET_PET);
      }
    `);
    expect(summaries.map((s) => s.identity.name)).toEqual(["usePet.GetPet"]);
    const graphql = readGraphqlMetadata(summaries[0]);
    expect(graphql?.document).toContain("fragment PetFields on Pet");
    expect(graphql?.document).toContain("fragment PetBase on Pet");
    expect(graphql?.unresolvedFragments).toBeUndefined();
  });

  it("splices a fragment two paths reach only once", async () => {
    const summaries = await runInMemory(`
      import { gql, useQuery } from "@apollo/client";
      const PET_BASE = gql\`
        fragment PetBase on Pet {
          id
        }
      \`;
      const NAME_FIELDS = gql\`
        fragment NameFields on Pet {
          ...PetBase
          name
        }
        \${PET_BASE}
      \`;
      const TAG_FIELDS = gql\`
        fragment TagFields on Pet {
          ...PetBase
          tag
        }
        \${PET_BASE}
      \`;
      const GET_PET = gql\`
        query GetPet {
          pet {
            ...NameFields
            ...TagFields
          }
        }
        \${NAME_FIELDS}
        \${TAG_FIELDS}
      \`;
      export function usePet() {
        return useQuery(GET_PET);
      }
    `);
    expect(summaries).toHaveLength(1);
    const document = readGraphqlMetadata(summaries[0])?.document ?? "";
    expect(document.match(/fragment PetBase on Pet/g)).toHaveLength(1);
    expect(readGraphqlMetadata(summaries[0])?.unresolvedFragments).toBe(
      undefined,
    );
  });

  it("records the spread a dynamic top-level interpolation leaves dangling", async () => {
    const summaries = await runInMemory(`
      import { gql, useQuery } from "@apollo/client";
      declare const extraDefinitions: string;
      const GET_PET = gql\`
        query GetPet {
          pet {
            ...PetFields
          }
        }
        \${extraDefinitions}
      \`;
      export function usePet() {
        return useQuery(GET_PET);
      }
    `);
    expect(summaries.map((s) => s.identity.name)).toEqual(["usePet.GetPet"]);
    const graphql = readGraphqlMetadata(summaries[0]);
    expect(graphql?.document).toContain("...PetFields");
    expect(graphql?.unresolvedFragments).toEqual(["PetFields"]);
  });

  it("withholds the document when a dynamic interpolation is inside a selection set", async () => {
    const summaries = await runInMemory(`
      import { gql, useQuery } from "@apollo/client";
      declare const extraFields: string;
      const GET_PET = gql\`
        query GetPet {
          pet {
            id
            \${extraFields}
          }
        }
      \`;
      export function usePet() {
        return useQuery(GET_PET);
      }
    `);
    expect(summaries.map((s) => s.identity.name)).toEqual(["usePet.GetPet"]);
    const graphql = readGraphqlMetadata(summaries[0]);
    expect(graphql?.document).toBeUndefined();
    expect(graphql?.unresolvedDocument?.reference).toBe("GET_PET");
    expect(graphql?.unresolvedDocument?.reason).toContain("selection set");
  });

  it("marks a dropped top-level interpolation that left no spread behind", async () => {
    const summaries = await runInMemory(`
      import { gql, useQuery } from "@apollo/client";
      declare const trailer: string;
      const PING = gql\`
        query Ping {
          ping
        }
        \${trailer}
      \`;
      export function usePing() {
        return useQuery(PING);
      }
    `);
    expect(summaries.map((s) => s.identity.name)).toEqual(["usePing.Ping"]);
    const graphql = readGraphqlMetadata(summaries[0]);
    expect(graphql?.document).toContain("query Ping");
    expect(graphql?.unresolvedDocument?.reason).toContain("trailer");
  });
});

// ---------------------------------------------------------------------------
// Fragments spread by name, the way codegen's client preset writes them
// ---------------------------------------------------------------------------

// A component writes its own fragment and the page spreads it by name,
// interpolating nothing and importing nothing: codegen finds the
// definition among the project's documents.
describe("apolloClientPack, client-preset fragments", () => {
  const generatedGql = `
    export function gql(source: string): unknown {
      return { source };
    }
  `;

  const profilePage = `
    import { useQuery } from "@apollo/client";
    import { gql } from "./generated/gql.js";
    const ProfileQuery = gql(/* GraphQL */ \`
      query Profile($id: ID!) {
        user(id: $id) {
          ...UserCard
          email
        }
      }
    \`);
    export function useProfile(id: string) {
      return useQuery(ProfileQuery, { variables: { id } });
    }
  `;

  it("puts the definition the project writes elsewhere into the document", async () => {
    const summaries = await runInMemoryFiles({
      "generated/gql.ts": generatedGql,
      "userCard.ts": `
        import { gql } from "./generated/gql.js";
        export const UserCardFragment = gql(/* GraphQL */ \`
          fragment UserCard on User {
            id
            name
            avatarUrl
          }
        \`);
      `,
      "profile.ts": profilePage,
    });
    expect(summaries.map((s) => s.identity.name)).toEqual([
      "useProfile.Profile",
    ]);
    const graphql = readGraphqlMetadata(summaries[0]);
    expect(graphql?.document).toContain("fragment UserCard on User");
    expect(graphql?.document).toContain("avatarUrl");
    expect(graphql?.unresolvedFragments).toBeUndefined();
    expect(graphql?.ambiguousFragments).toBeUndefined();
  });

  it("uses neither body when two files define the fragment differently", async () => {
    const summaries = await runInMemoryFiles({
      "generated/gql.ts": generatedGql,
      "userCard.ts": `
        import { gql } from "./generated/gql.js";
        export const UserCardFragment = gql(/* GraphQL */ \`
          fragment UserCard on User { id name }
        \`);
      `,
      "adminCard.ts": `
        import { gql } from "./generated/gql.js";
        export const AdminCardFragment = gql(/* GraphQL */ \`
          fragment UserCard on User { id email }
        \`);
      `,
      "profile.ts": profilePage,
    });
    const graphql = readGraphqlMetadata(summaries[0]);
    expect(graphql?.document).not.toContain("fragment UserCard");
    expect(graphql?.unresolvedFragments).toEqual(["UserCard"]);
    expect(graphql?.ambiguousFragments).toEqual(["UserCard"]);
  });
});

// ---------------------------------------------------------------------------
// Documents held in named constants
// ---------------------------------------------------------------------------

// Nearly every codebase past a handful of operations writes the
// document as an exported constant and imports the name, so this is
// what a hook call usually looks like. The fixture puts a barrel
// between the two, which is what defeats reading one variable
// declaration.
async function runDocumentsAdapter(): Promise<BehavioralSummary[]> {
  const documentsDir = path.join(fixturesDir, "documents");
  const project = createFixtureProject(documentsDir, "**/*.ts");
  project.addSourceFilesAtPaths(path.join(documentsDir, "**/*.tsx"));
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [apolloClientPack()],
  });
  return await adapter.extractAll();
}

describe("apolloClientPack (documents in named constants)", () => {
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await runDocumentsAdapter();
  }, 90_000);

  function operationType(operationName: string): string | null {
    for (const summary of summaries) {
      const sem = summary.identity.boundaryBinding?.semantics;
      if (
        sem?.name === "graphql-operation" &&
        sem.operationName === operationName
      ) {
        return sem.operationType;
      }
    }
    return null;
  }

  it("reads a document a gql tag call built, imported through a barrel", async () => {
    expect(operationType("WidgetSettings")).toBe("query");
    const summary = summaries.find(
      (s) => s.identity.name === "useWidgetSettings.WidgetSettings",
    );
    const variables = (summary?.inputs ?? []).filter(
      (input) => input.type === "parameter",
    );
    expect(variables.map((input) => input.name)).toContain("region");
  });

  it("reads a document the generated `graphql` function built", async () => {
    expect(operationType("CreateWidget")).toBe("mutation");
  });

  it("reads a tagged-template document imported through a barrel", async () => {
    expect(operationType("OnTick")).toBe("subscription");
  });

  it("follows a same-module alias to the document it stands for", async () => {
    expect(operationType("SearchUsers")).toBe("query");
  });

  it("keeps two hook calls in one component apart", async () => {
    const picker = summaries.filter((s) =>
      s.identity.name.startsWith("UserPicker."),
    );
    expect(picker.map((s) => s.identity.name).sort()).toEqual([
      "UserPicker.SearchUsers",
      "UserPicker.User",
    ]);
  });

  it("reports a document the code computes as a gap, naming the argument", async () => {
    const chosen = summaries.filter((s) =>
      s.identity.name.startsWith("useChosen."),
    );
    expect(chosen).toHaveLength(1);
    const gap = readGraphqlMetadata(chosen[0])?.unresolvedDocument;
    expect(gap?.reference).toBe("CHOSEN_DOCUMENT");
  });

  it("leaves no gap behind on a document it could read", async () => {
    const gaps = summaries.filter(
      (s) =>
        !s.identity.name.startsWith("useChosen.") &&
        readGraphqlMetadata(s)?.unresolvedDocument !== undefined,
    );
    expect(gaps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A project hook in front of the library's
// ---------------------------------------------------------------------------

const WRAPPER_HOOKS = `
  import { useMutation, useQuery } from "@apollo/client";
  export const useAppQuery = (query: unknown, options?: unknown) =>
    useQuery(query as never, options as never);
  export function useAppMutation(mutation: unknown) {
    return useMutation(mutation as never);
  }
`;

/** Why a summary's document went unread, when it did. */
function reasonOf(summary: BehavioralSummary | undefined): string | undefined {
  if (summary === undefined) {
    return undefined;
  }
  return readGraphqlMetadata(summary)?.unresolvedDocument?.reason;
}

function operationOf(
  summaries: BehavioralSummary[],
  name: string,
): { operationType: string; operationName?: string } | null {
  const semantics = summaries.find((s) => s.identity.name === name)?.identity
    .boundaryBinding?.semantics;
  if (semantics?.name !== "graphql-operation") {
    return null;
  }
  return {
    operationType: semantics.operationType,
    ...(semantics.operationName !== undefined
      ? { operationName: semantics.operationName }
      : {}),
  };
}

describe("apolloClientPack — a project hook wrapping the library's", () => {
  it("gives each component calling it an operation of its own", async () => {
    const summaries = await runInMemoryFiles({
      "hooks.ts": WRAPPER_HOOKS,
      "profile.ts": `
        import { gql } from "@apollo/client";
        import { useAppQuery } from "./hooks.js";
        const ProfileQuery = gql\`query Profile($id: ID!) { user(id: $id) { id } }\`;
        export function Profile(id: string) {
          return useAppQuery(ProfileQuery, { variables: { id } });
        }
      `,
      "settings.ts": `
        import { gql } from "@apollo/client";
        import { useAppQuery } from "./hooks.js";
        const SettingsQuery = gql\`query Settings { settings { id } }\`;
        export function Settings() {
          return useAppQuery(SettingsQuery);
        }
      `,
    });

    expect(operationOf(summaries, "Profile.Profile")).toEqual({
      operationType: "query",
      operationName: "Profile",
    });
    expect(operationOf(summaries, "Settings.Settings")).toEqual({
      operationType: "query",
      operationName: "Settings",
    });
  });

  it("puts each operation in the file the component is written in", async () => {
    const summaries = await runInMemoryFiles({
      "hooks.ts": WRAPPER_HOOKS,
      "profile.ts": `
        import { gql } from "@apollo/client";
        import { useAppQuery } from "./hooks.js";
        const ProfileQuery = gql\`query Profile { me { id } }\`;
        export function Profile() {
          return useAppQuery(ProfileQuery);
        }
      `,
    });

    const profile = summaries.find(
      (s) => s.identity.name === "Profile.Profile",
    );
    expect(profile?.location.file).toContain("profile.ts");
  });

  it("drops the wrapper's own summary once every caller has one", async () => {
    const summaries = await runInMemoryFiles({
      "hooks.ts": WRAPPER_HOOKS,
      "profile.ts": `
        import { gql } from "@apollo/client";
        import { useAppQuery } from "./hooks.js";
        const ProfileQuery = gql\`query Profile { me { id } }\`;
        export function Profile() {
          return useAppQuery(ProfileQuery);
        }
      `,
    });

    expect(
      summaries.filter((s) => s.identity.name.startsWith("useAppQuery.")),
    ).toEqual([]);
  });

  it("takes the operation type from the document a mutation wrapper is given", async () => {
    const summaries = await runInMemoryFiles({
      "hooks.ts": WRAPPER_HOOKS,
      "widget.ts": `
        import { gql } from "@apollo/client";
        import { useAppMutation } from "./hooks.js";
        const CreateWidget = gql\`mutation CreateWidget($label: String!) { createWidget(label: $label) { id } }\`;
        export function CreateWidget() {
          return useAppMutation(CreateWidget);
        }
      `,
    });

    expect(operationOf(summaries, "CreateWidget.CreateWidget")).toEqual({
      operationType: "mutation",
      operationName: "CreateWidget",
    });
  });

  it("follows a wrapper over a wrapper to the component at the top", async () => {
    const summaries = await runInMemoryFiles({
      "hooks.ts": WRAPPER_HOOKS,
      "legacy.ts": `
        import { useAppQuery } from "./hooks.js";
        export function useLegacyQuery(query: unknown) {
          return useAppQuery(query, { legacy: true });
        }
      `,
      "panel.ts": `
        import { gql } from "@apollo/client";
        import { useLegacyQuery } from "./legacy.js";
        const OrdersQuery = gql\`query Orders { orders { id } }\`;
        export function Panel() {
          return useLegacyQuery(OrdersQuery);
        }
      `,
    });

    expect(operationOf(summaries, "Panel.Orders")).toEqual({
      operationType: "query",
      operationName: "Orders",
    });
    expect(
      summaries.filter((s) => s.identity.name.startsWith("useLegacyQuery.")),
    ).toEqual([]);
  });

  it("resolves a document the component imported from another module", async () => {
    const summaries = await runInMemoryFiles({
      "hooks.ts": WRAPPER_HOOKS,
      "documents.ts": `
        import { gql } from "@apollo/client";
        export const SettingsQuery = gql\`query Settings { settings { id } }\`;
      `,
      "settings.ts": `
        import { useAppQuery } from "./hooks.js";
        import { SettingsQuery } from "./documents.js";
        export function Settings() {
          return useAppQuery(SettingsQuery);
        }
      `,
    });

    expect(operationOf(summaries, "Settings.Settings")).toEqual({
      operationType: "query",
      operationName: "Settings",
    });
  });

  it("finds a caller that reaches the wrapper only through a barrel", async () => {
    const summaries = await runInMemoryFiles({
      "hooks.ts": WRAPPER_HOOKS,
      "index.ts": `export { useAppQuery } from "./hooks.js";`,
      "profile.ts": `
        import { gql } from "@apollo/client";
        import { useAppQuery } from "./index.js";
        const ProfileQuery = gql\`query Profile { me { id } }\`;
        export function Profile() {
          return useAppQuery(ProfileQuery);
        }
      `,
    });

    expect(operationOf(summaries, "Profile.Profile")).toEqual({
      operationType: "query",
      operationName: "Profile",
    });
  });

  it("reports the gap on the component when its document is computed", async () => {
    const summaries = await runInMemoryFiles({
      "hooks.ts": WRAPPER_HOOKS,
      "dashboard.ts": `
        import { gql } from "@apollo/client";
        import { useAppQuery } from "./hooks.js";
        const Weekly = gql\`query Weekly { weekly { id } }\`;
        const Daily = gql\`query Daily { daily { id } }\`;
        declare const preferWeekly: boolean;
        export function Dashboard() {
          return useAppQuery(preferWeekly ? Weekly : Daily);
        }
      `,
    });

    const dashboard = summaries.filter((s) =>
      s.identity.name.startsWith("Dashboard."),
    );
    expect(dashboard).toHaveLength(1);
    expect(
      readGraphqlMetadata(dashboard[0])?.unresolvedDocument?.reference,
    ).toBe("preferWeekly ? Weekly : Daily");
  });

  it("keeps the wrapper's own summary when nothing in the run calls it", async () => {
    const summaries = await runInMemoryFiles({ "hooks.ts": WRAPPER_HOOKS });

    const wrapper = summaries.find((s) =>
      s.identity.name.startsWith("useAppQuery."),
    );
    expect(reasonOf(wrapper)).toBe(
      "the document argument is this function's parameter, and no call of the function was found in the files read",
    );
  });

  it("says how many callers it read when only some could be followed", async () => {
    const summaries = await runInMemoryFiles({
      "hooks.ts": WRAPPER_HOOKS,
      "profile.ts": `
        import { gql } from "@apollo/client";
        import { useAppQuery } from "./hooks.js";
        const ProfileQuery = gql\`query Profile { me { id } }\`;
        export function Profile() {
          return useAppQuery(ProfileQuery);
        }
      `,
      "topLevel.ts": `
        import { gql } from "@apollo/client";
        import { useAppQuery } from "./hooks.js";
        const PingQuery = gql\`query Ping { ping }\`;
        export const ping = useAppQuery(PingQuery);
      `,
    });

    const wrapper = summaries.find((s) =>
      s.identity.name.startsWith("useAppQuery."),
    );
    expect(reasonOf(wrapper)).toBe(
      "the document argument is this function's parameter: 1 of its callers were read as operations of their own, and 1 could not be followed",
    );
  });

  it("reads the caller's destructured result the way a direct hook call is read", async () => {
    const body = (call: string) => `
      export function Profile() {
        const { data, error } = ${call};
        if (error !== undefined) { return "unavailable"; }
        return data;
      }
    `;
    const wrapped = await runInMemoryFiles({
      "hooks.ts": WRAPPER_HOOKS,
      "profile.ts": `
        import { gql } from "@apollo/client";
        import { useAppQuery } from "./hooks.js";
        const ProfileQuery = gql\`query Profile { me { id } }\`;
        ${body("useAppQuery(ProfileQuery)")}
      `,
    });
    const direct = await runInMemoryFiles({
      "profile.ts": `
        import { gql, useQuery } from "@apollo/client";
        const ProfileQuery = gql\`query Profile { me { id } }\`;
        ${body("useQuery(ProfileQuery)")}
      `,
    });

    const shapeOf = (summaries: BehavioralSummary[]) =>
      summaries
        .find((s) => s.identity.name === "Profile.Profile")
        ?.transitions.map((t) => t.expectedInput);
    expect(shapeOf(wrapped)).toEqual(shapeOf(direct));
    expect(shapeOf(direct)).toContainEqual({
      type: "record",
      properties: { error: { type: "unknown" }, data: { type: "unknown" } },
    });
  });
});
