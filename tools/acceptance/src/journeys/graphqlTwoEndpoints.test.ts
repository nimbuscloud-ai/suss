import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, runSuss, workspace } from "../harness.js";

/**
 * A frontend that talks to two GraphQL services through one hook, which
 * picks the client from an option each caller passes. The two schemas
 * share root field names, so pairing by field name alone checks an
 * operation against whichever schema has the name, and every field only
 * the other service declares comes out as an error.
 */
describe("check a frontend whose own hook picks one of two GraphQL services", () => {
  const project = fixture("graphql-two-endpoints");

  /** Extract the fixture and read both schemas into one folder. */
  function extractInto(label: string, packConfig: string | null): string {
    const summaries = workspace(label);
    const pack =
      packConfig === null
        ? "apollo-client"
        : `apollo-client=${path.join(project, packConfig)}`;
    const code = runSuss([
      "extract",
      "--dir",
      project,
      "-f",
      pack,
      "-o",
      path.join(summaries, "code.json"),
    ]);
    expect(code.status, code.stderr).toBe(0);

    // Read from inside the project, so each schema is labelled with the
    // path the pack config points at.
    for (const schema of ["legacy", "appsync"]) {
      const read = runSuss(
        [
          "contract",
          "--from",
          "graphql",
          `schema/${schema}.graphql`,
          "-o",
          path.join(summaries, `${schema}.json`),
        ],
        { cwd: project },
      );
      expect(read.status, read.stderr).toBe(0);
    }
    return summaries;
  }

  describe("with each client bound to its schema", () => {
    let summaries: string;

    beforeAll(() => {
      summaries = extractInto("graphql-two-endpoints", "apollo.json");
    });

    it("pairs each operation with the schema of the service its caller picked", () => {
      const check = runSuss(["check", "--dir", summaries, "--all"]);

      expect(check.stdout).toContain(
        "schema/appsync.graphql:Query.events::Query.events <-> graphql-two-endpoints::src/eventListing.tsx::EventListing.EventListing",
      );
      expect(check.stdout).not.toContain(
        "schema/legacy.graphql:Query.events::Query.events <-> graphql-two-endpoints::src/eventListing.tsx::EventListing.EventListing",
      );
      expect(check.stdout).toContain(
        "schema/legacy.graphql:Query.account::Query.account <-> graphql-two-endpoints::src/accountPage.tsx::AccountPage.AccountPage",
      );
      expect(check.stdout).toContain(
        "schema/appsync.graphql:Query.venue::Query.venue <-> graphql-two-endpoints::src/venueCard.tsx::VenueCard.VenueCard",
      );
    });

    it("reports the stale field and nothing the newer API declares", () => {
      const check = runSuss(["check", "--dir", summaries]);

      expect(check.status).toBe(1);
      expect(check.stdout).toContain(
        'GraphQL operation "AccountPage.AccountPage" selects "Account.nickname"',
      );
      expect(check.stdout).not.toContain("Event.venue");
      expect(check.stdout).toContain("1 finding: 1 error");
    });

    it("lists the operation a feature flag routes as not checked, and says why", () => {
      const check = runSuss(["check", "--dir", summaries]);

      expect(check.stdout).toContain(
        "1 GraphQL operation was not checked, because suss could not tell which service its client talks to:\n  graphql-two-endpoints::src/featurePanel.tsx::FeaturePanel.FeaturePanel: the client it passes, nextGen ? appSyncClient : railsClient, can be any of 2 clients, and nothing the call passes settles which",
      );
    });
  });

  describe("with no client bound", () => {
    it("checks nothing it cannot tie to a service, and says which binding to add", () => {
      const summaries = extractInto("graphql-two-endpoints-unbound", null);
      const check = runSuss(["check", "--dir", summaries, "--json"]);
      const report = JSON.parse(check.stdout) as {
        findings: Array<{ kind: string; description: string }>;
        unmatched: {
          unpairable: Array<{ name: string; reason: string; detail?: string }>;
        };
      };

      expect(
        report.findings.filter((f) => f.kind === "boundaryFieldUnknown"),
      ).toEqual([]);
      expect(
        report.unmatched.unpairable.find(
          (u) => u.name === "EventListing.EventListing",
        ),
      ).toEqual({
        id: "graphql-two-endpoints::src/eventListing.tsx::EventListing.EventListing",
        name: "EventListing.EventListing",
        key: "query EventListing",
        reason: "unknownService",
        detail:
          "it passes the client built with https://events.appsync-api.example.com/graphql, the project builds more than one client, and no `clients` entry in the pack options says which service https://events.appsync-api.example.com/graphql talks to",
      });
    });
  });
});
