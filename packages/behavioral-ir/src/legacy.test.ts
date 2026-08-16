import { describe, expect, it } from "vitest";

import {
  parseSummaries,
  parseSummary,
  SUMMARY_SCHEMA_VERSION,
  safeParseSummary,
} from "./index.js";

function v1Summary(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "handler",
    location: {
      file: "src/producer.ts",
      range: { start: 0, end: 0 },
      exportName: "handler",
    },
    identity: {
      name: "Producer.handler",
      exportPath: null,
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    ...overrides,
  };
}

describe("reading version-1 artifacts", () => {
  it("normalizes an empty channel on a v1 effect binding to null", () => {
    const parsed = parseSummary(
      v1Summary({
        transitions: [
          {
            id: "t-0",
            conditions: [],
            output: { type: "void" },
            effects: [
              {
                type: "interaction",
                binding: {
                  transport: "sqs",
                  semantics: {
                    name: "message-bus",
                    messageBus: "sqs",
                    channel: "",
                  },
                  recognition: "@suss/framework-aws-sqs",
                },
                interaction: { class: "message-send" },
              },
            ],
            location: { start: 0, end: 0 },
            isDefault: true,
          },
        ],
      }),
    );
    const effect = parsed.transitions[0]?.effects[0];
    expect(
      effect?.type === "interaction" &&
        effect.binding.semantics.name === "message-bus" &&
        effect.binding.semantics.channel,
    ).toBeNull();
  });

  it("normalizes empty v1 identity fields on the summary's own binding", () => {
    const parsed = parseSummary(
      v1Summary({
        identity: {
          name: "pagesApi",
          exportPath: null,
          boundaryBinding: {
            transport: "http",
            semantics: { name: "rest", method: "", path: "" },
            recognition: "nextjs",
          },
        },
      }),
    );
    const semantics = parsed.identity.boundaryBinding?.semantics;
    expect(semantics?.name === "rest" && semantics.method).toBeNull();
    expect(semantics?.name === "rest" && semantics.path).toBeNull();
  });

  it("rejects an empty identity field on a summary from the version that stopped allowing one", () => {
    const result = safeParseSummary(
      v1Summary({
        schemaVersion: 2,
        identity: {
          name: "pagesApi",
          exportPath: null,
          boundaryBinding: {
            transport: "http",
            semantics: { name: "rest", method: "", path: "/x" },
            recognition: "nextjs",
          },
        },
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe("reading storage written before the layered variant", () => {
  function v3StorageSummary(
    semantics: Record<string, unknown>,
    metadata?: Record<string, unknown>,
  ): Record<string, unknown> {
    return v1Summary({
      schemaVersion: 3,
      identity: {
        name: "User",
        exportPath: null,
        id: "schema.prisma::User",
        boundaryBinding: {
          transport: "postgres",
          semantics,
          recognition: "prisma",
        },
      },
      ...(metadata === undefined ? {} : { metadata }),
    });
  }

  it("reads a storage-relational table as a storage container", () => {
    const parsed = parseSummary(
      v3StorageSummary({
        name: "storage-relational",
        storageSystem: "postgres",
        scope: "default",
        table: "User",
      }),
    );
    expect(parsed.identity.boundaryBinding?.semantics).toEqual({
      name: "storage",
      storageSystem: "postgres",
      scope: "default",
      container: "User",
      accessPath: null,
    });
  });

  it("reads a table nobody could settle as a null container", () => {
    const parsed = parseSummary(
      v3StorageSummary({
        name: "storage-relational",
        storageSystem: "postgres",
        scope: "default",
        table: null,
      }),
    );
    expect(parsed.identity.boundaryBinding?.semantics).toMatchObject({
      container: null,
    });
  });

  it("reads an older schema reader's columns as fields, and as the complete set", () => {
    const parsed = parseSummary(
      v3StorageSummary(
        {
          name: "storage-relational",
          storageSystem: "postgres",
          scope: "default",
          table: "User",
        },
        { storageContract: { columns: [{ name: "id" }], indexes: [] } },
      ),
    );
    expect(parsed.metadata?.storageContract).toEqual({
      fieldSet: "exhaustive",
      fields: [{ name: "id" }],
      indexes: [],
    });
  });

  it("leaves a contract that declares no columns as it was", () => {
    const parsed = parseSummary(
      v3StorageSummary(
        {
          name: "storage-relational",
          storageSystem: "postgres",
          scope: "default",
          table: "User",
        },
        { storageContract: { physicalTable: "users" } },
      ),
    );
    expect(parsed.metadata?.storageContract).toEqual({
      physicalTable: "users",
    });
  });

  it("relayers a storage binding an effect states, not only the summary's own", () => {
    const parsed = parseSummary(
      v1Summary({
        schemaVersion: 3,
        identity: {
          name: "getUser",
          exportPath: null,
          id: "src/getUser.ts::getUser",
          boundaryBinding: null,
        },
        transitions: [
          {
            id: "t-0",
            conditions: [],
            output: { type: "void" },
            effects: [
              {
                type: "interaction",
                binding: {
                  transport: "postgres",
                  semantics: {
                    name: "storage-relational",
                    storageSystem: "postgres",
                    scope: "default",
                    table: "User",
                  },
                  recognition: "@suss/framework-prisma",
                },
                interaction: {
                  class: "storage-access",
                  kind: "read",
                  fields: ["email"],
                },
              },
            ],
            location: { start: 0, end: 0 },
            isDefault: true,
          },
        ],
      }),
    );
    const effect = parsed.transitions[0]?.effects[0];
    expect(
      effect?.type === "interaction" ? effect.binding.semantics : null,
    ).toMatchObject({ name: "storage", container: "User" });
  });

  it("leaves a summary written at the current version alone", () => {
    const parsed = parseSummary(
      v1Summary({
        schemaVersion: SUMMARY_SCHEMA_VERSION,
        identity: {
          name: "User",
          exportPath: null,
          id: "schema.prisma::User",
          boundaryBinding: {
            transport: "dynamodb",
            semantics: {
              name: "storage",
              storageSystem: "dynamodb",
              scope: "default",
              container: "Orders",
              accessPath: "byCustomer",
            },
            recognition: "cloudformation",
          },
        },
        metadata: { storageContract: { fieldSet: "partial", columns: [] } },
      }),
    );
    expect(parsed.identity.boundaryBinding?.semantics).toMatchObject({
      accessPath: "byCustomer",
    });
    expect(parsed.metadata?.storageContract).toMatchObject({
      fieldSet: "partial",
    });
  });
});

describe("backfilling identity.id", () => {
  it("stamps a v1 summary's id from its file and name", () => {
    const parsed = parseSummary(v1Summary({}));
    expect(parsed.identity.id).toBe("src/producer.ts::Producer.handler");
  });

  it("folds in the workspace and export path when the summary carries them", () => {
    const parsed = parseSummary(
      v1Summary({
        location: {
          file: "src/producer.ts",
          range: { start: 0, end: 0 },
          exportName: "handler",
          workspace: "svc-a",
        },
        identity: {
          name: "Producer.handler",
          exportPath: ["Producer", "handler"],
          boundaryBinding: null,
        },
      }),
    );
    expect(parsed.identity.id).toBe("svc-a::src/producer.ts::Producer.handler");
  });

  it("leaves an id its producer already stamped untouched", () => {
    const parsed = parseSummary(
      v1Summary({
        identity: {
          name: "Producer.handler",
          exportPath: null,
          boundaryBinding: null,
          id: "already-stamped",
        },
      }),
    );
    expect(parsed.identity.id).toBe("already-stamped");
  });

  it("does not backfill a summary from version 2 on that a producer left without one", () => {
    // A schemaVersion-2 artifact spelled identity in full; a missing
    // id there is the producer's own gap, not something the version-1
    // read path should paper over. Later versions changed other
    // fields and behave the same way, so both are pinned.
    for (const schemaVersion of [2, SUMMARY_SCHEMA_VERSION]) {
      const parsed = parseSummary(v1Summary({ schemaVersion }));
      expect(parsed.identity.id).toBeUndefined();
    }
  });

  it("leaves a summary with no file to build an id from unstamped, and validation rejects the shape on its own terms", () => {
    const result = safeParseSummary(
      v1Summary({
        location: { range: { start: 0, end: 0 }, exportName: "handler" },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("leaves a summary with no name to build an id from unstamped, and validation rejects the shape on its own terms", () => {
    const result = safeParseSummary(
      v1Summary({ identity: { exportPath: null, boundaryBinding: null } }),
    );
    expect(result.success).toBe(false);
  });

  it("settles two backfilled summaries of one function onto distinct ids", () => {
    // One function bound to two boundaries writes two v1 summaries with
    // the same name and file; the per-summary backfill mints one id for
    // both, and the schema says ids are unique across a run.
    const parsed = parseSummaries([
      v1Summary({
        identity: {
          name: "Producer.handler",
          exportPath: null,
          boundaryBinding: {
            transport: "http",
            semantics: { name: "rest", method: "GET", path: "/a" },
            recognition: "express",
          },
        },
      }),
      v1Summary({
        location: {
          file: "src/producer.ts",
          range: { start: 40, end: 60 },
          exportName: "handler",
        },
        identity: {
          name: "Producer.handler",
          exportPath: null,
          boundaryBinding: {
            transport: "http",
            semantics: { name: "rest", method: "POST", path: "/a" },
            recognition: "express",
          },
        },
      }),
    ]);
    expect(parsed[0].identity.id).not.toBe(parsed[1].identity.id);
  });

  it("keeps the ids an artifact wrote for itself, colliding or not", () => {
    const withOwnIds = [
      v1Summary({
        identity: {
          id: "suss::src/producer.ts::Producer.handler",
          name: "Producer.handler",
          exportPath: null,
          boundaryBinding: null,
        },
      }),
      v1Summary({
        identity: {
          id: "suss::src/producer.ts::Producer.handler",
          name: "Producer.handler",
          exportPath: null,
          boundaryBinding: null,
        },
      }),
    ];
    const parsed = parseSummaries(withOwnIds);
    expect(parsed[0].identity.id).toBe(parsed[1].identity.id);
  });
});
