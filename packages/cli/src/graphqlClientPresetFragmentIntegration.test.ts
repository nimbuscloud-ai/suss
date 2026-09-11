/**
 * A component's fragment and the operation another file spreads it
 * into, checked against the schema the server declares.
 *
 * The document the consumer writes has only `...UserCard` in it; the
 * definition is a file away and nothing imports it. Once the reader
 * puts that definition into the stored document, a field the schema
 * does not declare is reported wherever it was selected, inside the
 * fragment as much as inside the operation.
 */

import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { checkAll } from "@suss/checker";
import { graphqlSdlToSummaries } from "@suss/contract-graphql";
import apolloClient from "@suss/packs/apollo-client";
import { createTestProject } from "@suss/test-project";

import type { Finding } from "@suss/behavioral-ir";

const SCHEMA = `
  type Query {
    user(id: ID!): User
  }

  type User {
    id: ID!
    name: String
    avatarUrl: String
  }
`;

const GENERATED_GQL_MODULE = `
  export function gql(source: string): unknown {
    return { source };
  }
`;

async function findingsFor(cardSelections: string): Promise<Finding[]> {
  const project = createTestProject();
  project.createSourceFile("generated/gql.ts", GENERATED_GQL_MODULE);
  project.createSourceFile(
    "userCard.ts",
    `
    import { gql } from "./generated/gql.js";
    export const UserCardFragment = gql(/* GraphQL */ \`
      fragment UserCard on User { ${cardSelections} }
    \`);
  `,
  );
  project.createSourceFile(
    "profile.ts",
    `
    import { useQuery } from "@apollo/client";
    import { gql } from "./generated/gql.js";
    const ProfileQuery = gql(/* GraphQL */ \`
      query Profile($id: ID!) {
        user(id: $id) { ...UserCard }
      }
    \`);
    export function useProfile(id: string) {
      return useQuery(ProfileQuery, { variables: { id } });
    }
  `,
  );
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [apolloClient()],
  });
  const summaries = await adapter.extractAll();
  return checkAll([
    ...graphqlSdlToSummaries(SCHEMA, { source: "schema.graphql" }),
    ...summaries,
  ]).findings;
}

describe("a field selected through a fragment the consumer never imports", () => {
  it("reports the one the schema does not declare", async () => {
    const findings = await findingsFor("id handle");
    expect(
      findings
        .filter((finding) => finding.kind === "boundaryFieldUnknown")
        .map((finding) => finding.provider.summary),
    ).toEqual(["User.handle (undeclared)"]);
  });

  it("reports nothing when the schema declares every one of them", async () => {
    const findings = await findingsFor("id name avatarUrl");
    expect(
      findings.filter(
        (finding) =>
          finding.kind === "boundaryFieldUnknown" ||
          finding.kind === "lowConfidence",
      ),
    ).toEqual([]);
  });
});
