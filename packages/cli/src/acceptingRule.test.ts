import { describe, expect, it } from "vitest";

import { storageBinding } from "@suss/behavioral-ir";
import {
  applySuppressions,
  checkSchemaAgreement,
  checkStorage,
  SuppressionRuleSchema,
} from "@suss/checker";

import { acceptingRule, renderFindings } from "./check.js";

import type {
  BehavioralSummary,
  Finding,
  StorageContractMetadata,
} from "@suss/behavioral-ir";

type Field = NonNullable<StorageContractMetadata["fields"]>[number];

function declared(
  file: string,
  fields: Field[],
  origin?: "dump",
): BehavioralSummary {
  return {
    kind: "library",
    location: { file, range: { start: 1, end: 1 }, exportName: null },
    identity: {
      name: "attachments",
      exportPath: null,
      boundaryBinding: storageBinding({
        recognition: "test",
        storageSystem: "postgresql",
        scope: "default",
        container: "attachments",
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: {
        fieldSet: "exhaustive",
        fields,
        ...(origin !== undefined ? { origin } : {}),
      },
    },
  };
}

const ID: Field = { name: "id", type: "uuid", primary: true, nullable: false };

const rails = declared(
  "db/schema.rb",
  [
    ID,
    { name: "blob_id", type: "uuid", nullable: false, default: false },
    { name: "record_id", type: "uuid", nullable: false, default: false },
  ],
  "dump",
);

const drizzle = declared("src/db/schema.ts", [
  ID,
  { name: "blobId", column: "blob_id", type: "bigint", nullable: false },
  { name: "recordId", column: "record_id", type: "bigint", nullable: false },
]);

function accepted(findings: Finding[], rule: object): boolean[] {
  const parsed = SuppressionRuleSchema.parse({ ...rule, reason: "accepted" });
  return applySuppressions(findings, [parsed]).map(
    (f) => f.suppressed !== undefined,
  );
}

describe("the rule printed for a finding between two declarations of a table", () => {
  const { findings } = checkSchemaAgreement([rails, drizzle]);

  it("keys on the store and the copy's field", () => {
    expect(findings).toHaveLength(2);
    expect(acceptingRule(findings[0] as Finding)).toEqual({
      kind: "boundaryShapeMismatch",
      boundary: "postgresql:attachments",
      consumer: { field: "blobId" },
    });
  });

  it("accepts its own finding and no other column", () => {
    const rule = acceptingRule(findings[0] as Finding);
    expect(accepted(findings, rule as object)).toEqual([true, false]);
  });

  it("prints under the finding, ready to paste", () => {
    const output = renderFindings(findings.slice(0, 1), new Map());
    expect(output).toContain(
      [
        "  to silence this one, add to the rules in .sussignore.yml:",
        "    - kind: boundaryShapeMismatch",
        '      boundary: "postgresql:attachments"',
        '      consumer: { field: "blobId" }',
        "      reason: TODO say why you accept this",
      ].join("\n"),
    );
  });

  it("keys on the database's field when the copy leaves the column out", () => {
    const [missing] = checkSchemaAgreement([
      rails,
      declared("src/db/schema.ts", [ID]),
    ]).findings;
    expect(acceptingRule(missing as Finding)).toEqual({
      kind: "boundaryFieldUnknown",
      boundary: "postgresql:attachments",
      provider: { field: "blob_id" },
    });
  });

  it("prints none for the one warning a table gets when the keys differ", () => {
    const [keys] = checkSchemaAgreement([
      rails,
      declared("src/db/schema.ts", [
        { name: "id", type: "text", primary: true },
      ]),
    ]).findings;
    expect(acceptingRule(keys as Finding)).toBeNull();
  });
});

describe("the rule printed for a store's access finding", () => {
  const table = declared("db/schema.rb", [ID]);
  const reader: BehavioralSummary = {
    kind: "handler",
    location: {
      file: "src/attach.ts",
      range: { start: 1, end: 9 },
      exportName: "attach",
    },
    identity: { name: "attach", exportPath: ["attach"], boundaryBinding: null },
    inputs: [],
    transitions: [
      {
        id: "t-read",
        conditions: [],
        output: { type: "return", value: null },
        effects: [
          {
            type: "interaction",
            binding: storageBinding({
              recognition: "pg",
              storageSystem: "postgresql",
              scope: "default",
              container: "attachments",
            }),
            interaction: {
              class: "storage-access",
              kind: "read",
              fields: ["id", "filename"],
            },
          },
        ],
        location: { start: 2, end: 8 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };

  it("gives the store as the boundary beside the transition, and still matches", () => {
    const [unknown] = checkStorage([table, reader]);
    const rule = acceptingRule(unknown as Finding);
    expect(rule).toEqual({
      kind: "boundaryFieldUnknown",
      boundary: "postgresql:attachments",
      consumer: { transitionId: "t-read" },
    });
    expect(accepted([unknown as Finding], rule as object)).toEqual([true]);
  });

  it("prints none for an unused column, which has neither a transition nor a field", () => {
    const unused = checkStorage([
      declared("db/schema.rb", [
        ID,
        { name: "filename", type: "text" },
        { name: "size", type: "integer" },
      ]),
      reader,
    ]).filter((f) => f.kind === "boundaryFieldUnused");
    expect(unused).toHaveLength(1);
    expect(acceptingRule(unused[0] as Finding)).toBeNull();
  });
});
