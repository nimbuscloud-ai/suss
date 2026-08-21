import { describe, expect, it } from "vitest";

import { storageBinding } from "@suss/behavioral-ir";

import { boundariesTouchedBy } from "./boundaryReach.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

function summaryWith(effects: Effect[]): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "src/article.service.ts",
      range: { start: 1, end: 20 },
      exportName: "addComment",
    },
    identity: {
      name: "addComment",
      exportPath: ["addComment"],
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [
      {
        id: "t0",
        conditions: [],
        output: { type: "return", value: null },
        effects,
        location: { start: 1, end: 20 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function commentBinding() {
  return storageBinding({
    recognition: "prisma",
    storageSystem: "postgresql",
    scope: "default",
    container: "Comment",
    accessPath: null,
  });
}

describe("boundariesTouchedBy", () => {
  it("reports the table a query addresses", () => {
    const touched = boundariesTouchedBy(
      summaryWith([
        {
          type: "interaction",
          binding: commentBinding(),
          callee: "prisma.comment.create",
          interaction: {
            class: "storage-access",
            kind: "write",
            fields: ["body"],
            operation: "create",
          },
        },
      ]),
    );

    expect(touched.map((t) => `${t.relation} ${t.label}`)).toEqual([
      "writes postgresql:Comment",
    ]);
  });

  it("says nothing about a read written under a relation", () => {
    // `create({ data, include: { author: ... } })` reads the author,
    // and which table that is comes from the Comment contract, which
    // this walk over one summary has no sight of.
    const touched = boundariesTouchedBy(
      summaryWith([
        {
          type: "interaction",
          binding: commentBinding(),
          callee: "prisma.comment.create",
          interaction: {
            class: "storage-access",
            kind: "read",
            fields: ["username"],
            relationPath: ["author"],
            operation: "create",
          },
        },
      ]),
    );

    expect(touched).toEqual([]);
  });
});
