/**
 * A field list shared as a plain string, interpolated into an
 * operation, checked against the schema the server declares.
 *
 * The string is neither a document nor a fragment, so nothing about it
 * reaches the checker unless the reader splices its text. Once it does,
 * a field the schema does not declare is reported the same way it is
 * when the selection is written inside the template.
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

async function findingsFor(sharedSelections: string): Promise<Finding[]> {
  const project = createTestProject();
  project.createSourceFile(
    "fields.ts",
    `export const USER_FIELDS = \`${sharedSelections}\`;`,
  );
  project.createSourceFile(
    "profile.ts",
    `
    import { gql, useQuery } from "@apollo/client";
    import { USER_FIELDS } from "./fields";
    const ProfileQuery = gql\`
      query Profile($id: ID!) {
        user(id: $id) { \${USER_FIELDS} }
      }
    \`;
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

describe("a field selected through an interpolated string constant", () => {
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
