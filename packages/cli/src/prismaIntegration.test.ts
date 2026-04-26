// Prisma integration test — end-to-end relational-storage pairing
// with REAL extracted code (not hand-built summaries).
//
// Pipeline:
//   1. Extract code summaries from fixtures/prisma/src via the
//      TypeScript adapter, with @suss/framework-prisma in the pack
//      list so the recognizer fires on db.<model>.<method>(...) calls.
//   2. Read schema.prisma via @suss/contract-prisma → provider summaries.
//   3. Run checkAll over the union; assert findings.
//
// Two fixture cases (both deliberately typo'd):
//   - get-user-by-email: reads User.emial (typo) → storageReadFieldUnknown
//   - create-post: writes Post.bdoy (typo) → storageWriteFieldUnknown
//
// The schema declares User.deletedAt — no fixture reads it, so it
// surfaces as storageFieldUnused. Post.title is written but never
// read → storageWriteOnlyField.

import path from "node:path";

import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { checkAll } from "@suss/checker";
import { prismaSchemaFileToSummaries } from "@suss/contract-prisma";
import { prismaFramework } from "@suss/framework-prisma";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const repoRoot = path.resolve(__dirname, "../../..");
const fixtureRoot = path.join(repoRoot, "fixtures/prisma");
const schemaPath = path.join(fixtureRoot, "schema.prisma");

const lambdaHandlerPack: PatternPack = {
  name: "lambda-handler",
  protocol: "in-process",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: { type: "namedExport", names: ["handler"] },
      requiresImport: [],
    },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
  ],
  inputMapping: {
    type: "positionalParams",
    params: [{ position: 0, role: "event" }],
  },
};

describe("prisma integration", () => {
  it("emits the expected provider summary count (2 models = 2 summaries)", () => {
    const providers = prismaSchemaFileToSummaries(schemaPath);
    expect(providers).toHaveLength(2);
    expect(providers.map((p) => p.identity.name).sort()).toEqual([
      "Post",
      "User",
    ]);
  });

  it("emits storage-access interactions for db.<model>.<method>() calls", async () => {
    const code = await extractCode();
    const accesses = collectStorageAccesses(code);
    // get-user-by-email's findUnique + create-post's create.
    expect(accesses.length).toBeGreaterThanOrEqual(2);
    const tables = accesses
      .map((a) => readTable(a))
      .filter((t): t is string => t !== null)
      .sort();
    expect(tables).toContain("User");
    expect(tables).toContain("Post");
  });

  it("flags storageReadFieldUnknown when code reads User.emial (typo)", async () => {
    const findings = await runPipeline();
    const f = findings.find(
      (f) =>
        f.kind === "boundaryFieldUnknown" &&
        f.aspect === "read" &&
        f.description.includes("emial"),
    );
    expect(f).toBeDefined();
    expect(f?.severity).toBe("error");
    expect(f?.description).toContain("User");
  });

  it("flags storageWriteFieldUnknown when code writes Post.bdoy (typo)", async () => {
    const findings = await runPipeline();
    const f = findings.find(
      (f) =>
        f.kind === "boundaryFieldUnknown" &&
        f.aspect === "write" &&
        f.description.includes("bdoy"),
    );
    expect(f).toBeDefined();
    expect(f?.severity).toBe("error");
    expect(f?.description).toContain("Post");
  });

  it("flags storageFieldUnused for User.deletedAt (declared, never read)", async () => {
    const findings = await runPipeline();
    const f = findings.find(
      (f) =>
        f.kind === "boundaryFieldUnused" &&
        f.aspect === undefined &&
        f.description.includes("deletedAt"),
    );
    expect(f).toBeDefined();
    expect(f?.description).toContain("User");
  });

  it("does not flag declared-and-used columns (User.id, User.email, User.name)", async () => {
    const findings = await runPipeline();
    const storageish = findings.filter((f) => f.kind.startsWith("storage"));
    for (const col of ["User.id", "User.email", "User.name"]) {
      const false_positive = storageish.find((f) =>
        f.description.includes(col),
      );
      if (false_positive !== undefined) {
        throw new Error(
          `Unexpected finding for ${col}: ${false_positive.kind} — ${false_positive.description}`,
        );
      }
    }
  });
});

async function extractCode(): Promise<BehavioralSummary[]> {
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(fixtureRoot, "tsconfig.json"),
    frameworks: [lambdaHandlerPack, prismaFramework()],
    cacheDir: null,
  });
  const codeSummaries = await adapter.extractAll();
  for (const s of codeSummaries) {
    s.location.file = path.relative(fixtureRoot, s.location.file);
  }
  return codeSummaries;
}

async function runPipeline(): Promise<
  Awaited<ReturnType<typeof checkAll>>["findings"]
> {
  const code = await extractCode();
  const providers = prismaSchemaFileToSummaries(schemaPath);
  const { findings } = checkAll([...providers, ...code]);
  return findings;
}

interface StorageAccess {
  type: "interaction";
  binding: { semantics: { name: string; table?: string } };
  interaction: { class: string };
}

function collectStorageAccesses(
  summaries: BehavioralSummary[],
): StorageAccess[] {
  const out: StorageAccess[] = [];
  for (const summary of summaries) {
    for (const t of summary.transitions) {
      for (const e of t.effects) {
        if (
          e.type === "interaction" &&
          e.interaction.class === "storage-access"
        ) {
          out.push(e as unknown as StorageAccess);
        }
      }
    }
  }
  return out;
}

function readTable(a: StorageAccess): string | null {
  return a.binding.semantics.table ?? null;
}
