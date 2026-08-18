/**
 * A schema file and a client's operation documents, checked against
 * each other the way `suss contract --from graphql` then
 * `suss check --dir` does.
 *
 * The incident behind it: a client selected a field the backend's
 * schema did not declare, and every operation using that fragment
 * failed validation at the server. Nothing joins the two sides except
 * the schema, so the check has to read it out of the summary standing
 * for the schema document.
 */

import { describe, expect, it } from "vitest";

import { checkAll } from "@suss/checker";
import {
  graphqlDocumentsToSummaries,
  graphqlSdlToSummaries,
} from "@suss/contract-graphql";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

const SCHEMA = `
  type Query {
    directory(first: Int): UserConnection!
  }

  type UserConnection {
    nodes: [User!]!
    totalCount: Int!
  }

  type User {
    id: ID!
    name: String
    profile: Profile
  }

  type Profile {
    headline: String
  }
`;

function findingsFor(document: string): Finding[] {
  const summaries: BehavioralSummary[] = [
    ...graphqlSdlToSummaries(SCHEMA, { source: "schema.graphql" }),
    ...graphqlDocumentsToSummaries([
      { path: "web/directory.graphql", text: document },
    ]),
  ];
  return checkAll(summaries).findings;
}

function undeclaredSelections(document: string): string[] {
  return findingsFor(document)
    .filter((finding) => finding.kind === "boundaryFieldUnknown")
    .map((finding) => finding.provider.summary);
}

describe("a client selecting a field the schema does not declare", () => {
  it("reports it when the selection is written inline", () => {
    const document = `
      query Directory {
        directory(first: 10) {
          nodes { id name handle }
        }
      }
    `;
    expect(undeclaredSelections(document)).toEqual([
      "User.handle (undeclared)",
    ]);
  });

  it("reports it when the selection comes through a fragment", () => {
    const document = `
      fragment User_Card on User {
        id
        name
        handle
      }

      query Directory {
        directory(first: 10) {
          nodes { ...User_Card }
        }
      }
    `;
    expect(undeclaredSelections(document)).toEqual([
      "User.handle (undeclared)",
    ]);
  });

  it("says nothing when every selected field is declared", () => {
    const document = `
      query Directory {
        directory(first: 10) {
          totalCount
          nodes { id name }
        }
      }
    `;
    expect(findingsFor(document)).toEqual([]);
  });

  it("follows a nested object type and stops at its scalars", () => {
    const document = `
      query Directory {
        directory(first: 10) {
          nodes {
            profile { headline tagline }
          }
        }
      }
    `;
    expect(undeclaredSelections(document)).toEqual([
      "Profile.tagline (undeclared)",
    ]);
  });
});
