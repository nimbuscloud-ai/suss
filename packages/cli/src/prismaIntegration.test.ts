// prisma integration test — end-to-end relational-storage pairing.
//
// Pipeline: parse a real schema.prisma via @suss/contract-prisma →
// hand-build code summaries with `storageAccess` effects (the access
// pack lands in Phase 6.3) → run checkAll → assert the expected
// drift findings:
//
//   1. storageReadFieldUnknown  — code reads User.emial (typo)
//   2. storageWriteFieldUnknown — code writes Post.bdoy (typo)
//   3. storageFieldUnused       — User.deletedAt declared, never read
//   4. storageWriteOnlyField    — Post.title only ever written, never read
//
// The point of this test is not to re-cover what relationalPairing.test.ts
// already covers (it tests the checker against hand-built provider
// summaries). The point is to prove the @suss/contract-prisma OUTPUT
// is shape-compatible with what the checker expects — i.e. that the
// reader's columns / table / scope / storageSystem actually pair
// against the same fields on storageAccess effects.

import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkAll } from "@suss/checker";
import { prismaSchemaFileToSummaries } from "@suss/contract-prisma";

import type {
  BehavioralSummary,
  Effect,
  Transition,
} from "@suss/behavioral-ir";

const repoRoot = path.resolve(__dirname, "../../..");
const schemaPath = path.join(repoRoot, "fixtures/prisma/schema.prisma");

function makeAccessSummary(opts: {
  name: string;
  accesses: Array<{
    table: string;
    kind: "read" | "write";
    fields: string[];
    selector?: string[];
  }>;
}): BehavioralSummary {
  const transition: Transition = {
    id: `${opts.name}:t0`,
    conditions: [],
    output: { type: "return", value: null },
    effects: opts.accesses.map(
      (a): Effect => ({
        type: "storageAccess",
        kind: a.kind,
        storageSystem: "postgres",
        scope: "default",
        table: a.table,
        fields: a.fields,
        ...(a.selector !== undefined ? { selector: a.selector } : {}),
      }),
    ),
    location: { start: 5, end: 10 },
    isDefault: true,
  };
  return {
    kind: "handler",
    location: {
      file: `src/${opts.name}.ts`,
      range: { start: 1, end: 20 },
      exportName: opts.name,
    },
    identity: {
      name: opts.name,
      exportPath: [opts.name],
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [transition],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("prisma integration", () => {
  it("flags storageReadFieldUnknown when code reads User.emial (typo)", () => {
    const findings = runPipeline();
    const f = findings.find(
      (f) =>
        f.kind === "storageReadFieldUnknown" && f.description.includes("emial"),
    );
    expect(f).toBeDefined();
    expect(f?.severity).toBe("error");
    expect(f?.description).toContain("User");
  });

  it("flags storageWriteFieldUnknown when code writes Post.bdoy (typo)", () => {
    const findings = runPipeline();
    const f = findings.find(
      (f) =>
        f.kind === "storageWriteFieldUnknown" && f.description.includes("bdoy"),
    );
    expect(f).toBeDefined();
    expect(f?.severity).toBe("error");
    expect(f?.description).toContain("Post");
  });

  it("flags storageFieldUnused for User.deletedAt (declared, never read)", () => {
    const findings = runPipeline();
    const f = findings.find(
      (f) =>
        f.kind === "storageFieldUnused" && f.description.includes("deletedAt"),
    );
    expect(f).toBeDefined();
    expect(f?.description).toContain("User");
  });

  it("flags storageWriteOnlyField for Post.title (written, never read)", () => {
    const findings = runPipeline();
    const f = findings.find(
      (f) =>
        f.kind === "storageWriteOnlyField" && f.description.includes("title"),
    );
    expect(f).toBeDefined();
    expect(f?.description).toContain("Post");
  });

  it("does not flag declared-and-used columns (User.id, User.email, User.name)", () => {
    const findings = runPipeline();
    const storageish = findings.filter((f) => f.kind.startsWith("storage"));
    for (const col of ["User.id", "User.email", "User.name"]) {
      const false_positive = storageish.find((f) =>
        f.description.includes(col),
      );
      // Note: these are described via `<table>.<col>` or just `<col>`
      // depending on the finding kind, so a substring match is fine.
      if (false_positive !== undefined) {
        throw new Error(
          `Unexpected finding for ${col}: ${false_positive.kind} — ${false_positive.description}`,
        );
      }
    }
  });

  it("emits the expected provider summary count (2 models = 2 summaries)", () => {
    const providers = prismaSchemaFileToSummaries(schemaPath);
    expect(providers).toHaveLength(2);
    expect(providers.map((p) => p.identity.name).sort()).toEqual([
      "Post",
      "User",
    ]);
  });
});

function runPipeline(): ReturnType<typeof checkAll>["findings"] {
  const providers = prismaSchemaFileToSummaries(schemaPath);

  const codeSummaries: BehavioralSummary[] = [
    // Reader: looks up User by email, selects id+email+name.
    // Typo: also tries to project `emial` (the misspelling).
    makeAccessSummary({
      name: "getUserByEmail",
      accesses: [
        {
          table: "User",
          kind: "read",
          fields: ["id", "email", "name", "emial"],
          selector: ["email"],
        },
      ],
    }),
    // Writer: creates a Post with id, authorId, and a typo'd `bdoy`
    // (should be a column on Post but isn't — `body` doesn't even
    // exist on the model so this is a compound typo + unknown field).
    makeAccessSummary({
      name: "createPost",
      accesses: [
        {
          table: "Post",
          kind: "write",
          fields: ["id", "authorId", "title", "bdoy"],
        },
      ],
    }),
  ];

  const { findings } = checkAll([...providers, ...codeSummaries]);
  return findings;
}
