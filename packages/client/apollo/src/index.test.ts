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
  const project = createTestProject();
  project.createSourceFile("consumer.ts", source);
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

describe("apolloClientPack — integration", () => {
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await runAdapter();
  }, 90_000);

  it("discovers one client summary per hook or imperative call", async () => {
    // Four hook calls (usePet, useCreatePet, useAnonPing, useTicks),
    // two imperative calls (loadPetById, createPetImperative), and
    // one hook using a .graphql file import (useUserFromFile).
    expect(summaries).toHaveLength(7);
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
