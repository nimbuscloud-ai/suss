/**
 * Mongoose integration test: the recognizer through the full
 * extraction pipeline (not recognizer-in-isolation, which the pack's
 * own tests cover), against Mongoose's own types on disk.
 *
 * fixtures/mongoose declares two models: User (default-pluralized
 * collection "users") and Post (explicit collection "blog_posts").
 * Five handlers read and write across both, so the storage pass pairs
 * a writer and a reader on each collection.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import mongooseFramework from "@suss/framework-mongoose";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const repoRoot = path.resolve(__dirname, "../../..");
const fixtureRoot = path.join(repoRoot, "fixtures/mongoose");

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

async function extractCode(): Promise<BehavioralSummary[]> {
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(fixtureRoot, "tsconfig.json"),
    frameworks: [lambdaHandlerPack, mongooseFramework()],
    cacheDir: null,
  });
  const summaries = await adapter.extractAll();
  for (const s of summaries) {
    s.location.file = path.relative(fixtureRoot, s.location.file);
  }
  return summaries;
}

type StorageAccess = Extract<Effect, { type: "interaction" }> & {
  interaction: Extract<
    Extract<Effect, { type: "interaction" }>["interaction"],
    { class: "storage-access" }
  >;
};

function isStorageAccess(effect: Effect): effect is StorageAccess {
  return (
    effect.type === "interaction" &&
    effect.interaction.class === "storage-access"
  );
}

function storageAccesses(summaries: BehavioralSummary[]): StorageAccess[] {
  const out: StorageAccess[] = [];
  for (const summary of summaries) {
    for (const t of summary.transitions) {
      for (const e of t.effects) {
        if (isStorageAccess(e)) {
          out.push(e);
        }
      }
    }
  }
  return out;
}

function containerOf(access: StorageAccess): string | null {
  return access.binding.semantics.name === "storage"
    ? access.binding.semantics.container
    : null;
}

describe("mongoose integration", () => {
  it("emits storage-access interactions for every handler", async () => {
    const summaries = await extractCode();
    const accesses = storageAccesses(summaries);
    expect(accesses.length).toBeGreaterThanOrEqual(5);
  });

  it("resolves the default-pluralized collection for User", async () => {
    const summaries = await extractCode();
    const accesses = storageAccesses(summaries);
    const users = accesses.filter((a) => containerOf(a) === "users");
    expect(users.length).toBeGreaterThanOrEqual(3);

    const operations = users.map((a) => a.interaction.operation).sort();
    expect(operations).toEqual(["create", "findById", "findByIdAndUpdate"]);
  });

  it("resolves the schema's explicit collection for Post", async () => {
    const summaries = await extractCode();
    const accesses = storageAccesses(summaries);
    const posts = accesses.filter((a) => containerOf(a) === "blog_posts");
    expect(posts.length).toBeGreaterThanOrEqual(2);

    const operations = posts.map((a) => a.interaction.operation).sort();
    expect(operations).toEqual(["find", "save"]);
  });

  it("reads the write payload and read projection fields", async () => {
    const summaries = await extractCode();
    const accesses = storageAccesses(summaries);

    const created = accesses.find((a) => a.interaction.operation === "create");
    expect(created).toBeDefined();
    expect(created?.interaction.fields.sort()).toEqual(["email", "name"]);

    const found = accesses.find((a) => a.interaction.operation === "findById");
    expect(found?.interaction.fields.sort()).toEqual(["email", "name"]);
    expect(found?.interaction.selector).toEqual(["_id"]);
  });
});
