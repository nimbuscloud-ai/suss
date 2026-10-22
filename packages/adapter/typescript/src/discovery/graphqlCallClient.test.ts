import { Node, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { clientChosenAt } from "./graphqlCallClient.js";

import type { CallExpression } from "ts-morph";
import type { GraphqlClientSpec } from "./graphqlClientConstruction.js";

const SPECS: GraphqlClientSpec[] = [
  {
    importModule: "@apollo/client",
    importName: "ApolloClient",
    uriProperty: "uri",
    linkProperty: "link",
  },
  {
    importModule: "@apollo/client",
    importName: "HttpLink",
    uriProperty: "uri",
  },
];

const CLIENTS = `
  import { ApolloClient, ApolloLink, HttpLink } from "@apollo/client";
  export const a = new ApolloClient({ uri: "https://one.example.com" });
  export const b = new ApolloClient({
    link: new HttpLink({ uri: "https://two.example.com" }),
  });
  export const chained = new ApolloClient({
    link: ApolloLink.from([new HttpLink({ uri: "https://three.example.com" })]),
  });
`;

/** The project with `clients.ts` beside `code`, and the calls written in `code`. */
function callsIn(code: string): CallExpression[] {
  const project = createTestProject();
  project.createSourceFile("clients.ts", CLIENTS);
  const file = project.createSourceFile("code.ts", code);
  return file.getDescendantsOfKind(SyntaxKind.CallExpression);
}

/** The call to `name` in `code`, the first one when there are several. */
function callTo(calls: CallExpression[], name: string): CallExpression {
  const found = calls.find((call) => {
    const callee = call.getExpression();
    return Node.isPropertyAccessExpression(callee)
      ? callee.getName() === name
      : callee.getText() === name;
  });
  if (found === undefined) {
    throw new Error(`no call to ${name}`);
  }
  return found;
}

const OPTION = { argument: 1, property: "client" };

describe("clientChosenAt", () => {
  it("settles a client written into the call, through its transport", () => {
    const calls = callsIn(`
      import { useQuery } from "@apollo/client";
      import { b } from "./clients.js";
      export function Page() { return useQuery(Doc, { client: b }); }
    `);
    expect(
      clientChosenAt(
        { call: callTo(calls, "useQuery"), through: [], client: OPTION },
        SPECS,
        new ResolutionStore(),
      ),
    ).toEqual({
      kind: "settled",
      client: { uri: "https://two.example.com", uriRef: null },
    });
  });

  it("settles a client whose transport it cannot follow to its own construction", () => {
    const calls = callsIn(`
      import { useQuery } from "@apollo/client";
      import { chained } from "./clients.js";
      export function Page() { return useQuery(Doc, { client: chained }); }
    `);
    expect(
      clientChosenAt(
        { call: callTo(calls, "useQuery"), through: [], client: OPTION },
        SPECS,
        undefined,
      ),
    ).toEqual({ kind: "settled", client: { uri: null, uriRef: null } });
  });

  it("leaves the client to the app when the options pass none", () => {
    const calls = callsIn(`
      import { useQuery } from "@apollo/client";
      export function Page() { return useQuery(Doc, { variables: {} }); }
      export function Bare() { return useQuery(Doc); }
    `);
    const [withOptions, bare] = calls.filter(
      (call) => call.getExpression().getText() === "useQuery",
    );
    for (const call of [withOptions, bare]) {
      expect(
        clientChosenAt(
          { call: call as CallExpression, through: [], client: OPTION },
          SPECS,
          undefined,
        ),
      ).toBeNull();
    }
  });

  it("binds a project hook's parameters from the caller before reading its choice", () => {
    const calls = callsIn(`
      import { useQuery } from "@apollo/client";
      import { a, b } from "./clients.js";
      function useAppQuery(doc: unknown, { nextGen, ...opts }: { nextGen?: boolean } = {}) {
        const client = nextGen ? b : a;
        return useQuery(doc as never, { ...opts, client } as never);
      }
      export function Next() { return useAppQuery(Doc, { nextGen: true }); }
      export function Plain() { return useAppQuery(Doc); }
    `);
    const library = callTo(calls, "useQuery");
    const [next, plain] = calls.filter(
      (call) => call.getExpression().getText() === "useAppQuery",
    );
    const store = new ResolutionStore();
    expect(
      clientChosenAt(
        { call: library, through: [next as CallExpression], client: OPTION },
        SPECS,
        store,
      ),
    ).toEqual({
      kind: "settled",
      client: { uri: "https://two.example.com", uriRef: null },
    });
    expect(
      clientChosenAt(
        { call: library, through: [plain as CallExpression], client: OPTION },
        SPECS,
        store,
      ),
    ).toEqual({
      kind: "settled",
      client: { uri: "https://one.example.com", uriRef: null },
    });
  });

  it("says why when the choice stays open between two clients", () => {
    const calls = callsIn(`
      import { useQuery } from "@apollo/client";
      import { a, b } from "./clients.js";
      declare const preferNew: boolean;
      export function Page() { return useQuery(Doc, { client: preferNew ? b : a }); }
    `);
    expect(
      clientChosenAt(
        { call: callTo(calls, "useQuery"), through: [], client: OPTION },
        SPECS,
        undefined,
      ),
    ).toEqual({
      kind: "unresolved",
      reference: "preferNew ? b : a",
      reason:
        "the client it passes, preferNew ? b : a, can be any of 2 clients, and nothing the call passes settles which",
    });
  });

  it("says why when the client is no construction it can read, and shortens a long one", () => {
    const calls = callsIn(`
      import { useQuery } from "@apollo/client";
      declare function clientForTheCurrentWorkspaceAndRegion(workspace: string, region: string, mode: string): unknown;
      export function Page() {
        return useQuery(Doc, { client: clientForTheCurrentWorkspaceAndRegion("primary-workspace", "eu-west-1", "fallback") });
      }
    `);
    const chosen = clientChosenAt(
      { call: callTo(calls, "useQuery"), through: [], client: OPTION },
      SPECS,
      undefined,
    );
    expect(chosen?.kind).toBe("unresolved");
    expect(chosen?.kind === "unresolved" ? chosen.reference : "").toBe(
      `clientForTheCurrentWorkspaceAndRegion("primary-workspace", "eu-west-1", "fall...`,
    );
  });

  it("leaves a call the evaluator cannot run open only when the client is written out", () => {
    const calls = callsIn(`
      import { useQuery } from "@apollo/client";
      import { a } from "./clients.js";
      declare function opaque(doc: unknown, options: unknown): unknown;
      export function Written() { return useQuery(Doc, { client: a }); }
      export function Spread(options: object) { return useQuery(Doc, { ...options }); }
      export function Caller() { return opaque(Doc, {}); }
    `);
    const [written, spread] = calls.filter(
      (call) => call.getExpression().getText() === "useQuery",
    );
    const unreadable = callTo(calls, "opaque");
    expect(
      clientChosenAt(
        {
          call: written as CallExpression,
          through: [unreadable],
          client: OPTION,
        },
        SPECS,
        undefined,
      )?.kind,
    ).toBe("unresolved");
    expect(
      clientChosenAt(
        {
          call: spread as CallExpression,
          through: [unreadable],
          client: OPTION,
        },
        SPECS,
        undefined,
      ),
    ).toBeNull();
  });

  it("reads the client an imperative call is made on", () => {
    const calls = callsIn(`
      import { a, b } from "./clients.js";
      declare function currentClient(): { query(options: unknown): unknown };
      declare const preferNew: boolean;
      export const settled = a.query({ query: Doc });
      export const unknown = currentClient().query({ query: Doc });
      export const either = (preferNew ? a : b).query({ query: Doc });
    `);
    const [settled, unknown, either] = calls.filter((call) => {
      const callee = call.getExpression();
      return (
        Node.isPropertyAccessExpression(callee) && callee.getName() === "query"
      );
    });
    const read = (call: CallExpression | undefined) =>
      clientChosenAt(
        { call: call as CallExpression, through: [], client: "receiver" },
        SPECS,
        undefined,
      );
    expect(read(settled)).toEqual({
      kind: "settled",
      client: { uri: "https://one.example.com", uriRef: null },
    });
    expect(read(unknown)).toBeNull();
    expect(read(either)?.kind).toBe("unresolved");
  });
});
