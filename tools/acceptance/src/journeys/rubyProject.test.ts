// A person points suss at a Ruby service and reads back its GraphQL
// fields.
//
// graphql-ruby wires a field to a resolver class and looks that class
// up by name under a directory the app chooses, so the directory is
// the one thing the pack has to be told. It says so and stops rather
// than reading half the schema, which is the sentence this journey
// checks first.

import path from "node:path";

import { describe, expect, it } from "vitest";

import { copyOfFixture, runSuss, writePackConfig } from "../harness.js";

/** Every field fixtures/ruby-graphql declares, as a boundary name. */
const DECLARED_FIELDS = [
  "gql:Query.campaign",
  "gql:Mutation.campaignUpdate",
  "gql:Campaign.id",
  "gql:Campaign.name",
  "gql:Campaign.budget",
  "gql:Organizer.id",
  "gql:Organizer.email",
  "gql:Organizer.displayName",
  "gql:Organizer.status",
];

describe("read a graphql-ruby schema", () => {
  const project = copyOfFixture("ruby-graphql");
  const summariesFile = path.join(project, "summaries", "code.json");

  it("says what it needs before it reads anything", () => {
    const extract = runSuss(["extract", "-f", "graphql-ruby"], {
      cwd: project,
    });

    expect(extract.status).toBe(1);
    expect(extract.output).toContain("needs `root`");
    expect(extract.output).toContain("-f graphql-ruby=<config.json>");
    // A sentence, not a stack.
    expect(extract.output).not.toContain("    at ");
  });

  it("finds every wired field once it has the directory", () => {
    const config = writePackConfig(project, "graphql-ruby", {
      root: "app/graphql",
    });

    const extract = runSuss(
      [
        "extract",
        "--lang",
        "ruby",
        "-f",
        `graphql-ruby=${path.basename(config)}`,
        "-o",
        "summaries/code.json",
      ],
      { cwd: project },
    );
    expect(extract.status, extract.stderr).toBe(0);

    const inspect = runSuss(["inspect", summariesFile]);
    expect(inspect.status, inspect.stderr).toBe(0);
    for (const field of DECLARED_FIELDS) {
      expect(inspect.stdout).toContain(field);
    }
    expect(inspect.stdout).toContain("9 summaries.");
  });

  it("says which line each field is on, so a person can go there", () => {
    const inspect = runSuss(["inspect", summariesFile]);

    // campaign_type.rb declares id, name and budget on lines 2, 3 and
    // 4 of a 5-line file. The adapter recorded a byte offset here
    // until #215, so this printed `line 48`, `line 77` and `line 111`.
    expect(inspect.stdout).toContain(
      "gql:Campaign.id  (graphql-ruby resolver | line 2",
    );
    expect(inspect.stdout).toContain(
      "gql:Campaign.name  (graphql-ruby resolver | line 3",
    );
    expect(inspect.stdout).toContain(
      "gql:Campaign.budget  (graphql-ruby resolver | line 4",
    );
    expect(inspect.stdout).toContain(
      "gql:Query.campaign  (graphql-ruby resolver | line 2",
    );
  });

  it("names the file each field came from", () => {
    const inspect = runSuss(["inspect", summariesFile]);

    // Paths come out relative to the directory suss was pointed at, so
    // the summaries file moves between machines without breaking.
    expect(inspect.stdout).toContain("app/graphql/types/query_type.rb");
    expect(inspect.stdout).toContain("app/graphql/types/campaign_type.rb");
    expect(inspect.stdout).not.toContain(project);
  });
});
