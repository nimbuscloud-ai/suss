import { describe, expect, it } from "vitest";

import { parseSummary, safeParseSummary } from "./index.js";

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

  it("rejects an empty identity field on a summary that claims the current version", () => {
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

  it("does not backfill a current-version summary a producer left without one", () => {
    // A schemaVersion-2 artifact has spoken the current format in
    // full; a missing id there is the producer's own gap, not
    // something the version-1 read path should paper over.
    const parsed = parseSummary(v1Summary({ schemaVersion: 2 }));
    expect(parsed.identity.id).toBeUndefined();
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
});
