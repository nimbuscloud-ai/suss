import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { computePackApplicability } from "./preFilter.js";

import type {
  AccessRecognizer,
  InvocationRecognizer,
  PatternPack,
} from "@suss/extractor";
import type { Project, SourceFile } from "ts-morph";

const noopInvocation: InvocationRecognizer = () => null;
const noopAccess: AccessRecognizer = () => null;

/** Several fixture files in one project, in the order they are written. */
function makeFiles(files: Record<string, string>): SourceFile[] {
  const project = createTestProject();
  return Object.entries(files).map(([name, source]) =>
    project.createSourceFile(name, source),
  );
}

function basePack(overrides: Partial<PatternPack>): PatternPack {
  return {
    name: "test",
    protocol: "in-process",
    languages: ["typescript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    ...overrides,
  };
}

describe("computePackApplicability — pack-level requiresImport", () => {
  it("recognizer-only pack with requiresImport gates by import", () => {
    const sqsPack = basePack({
      name: "sqs",
      requiresImport: ["@aws-sdk/client-sqs"],
      invocationRecognizers: [noopInvocation],
    });
    const [importsSqs, noImports] = makeFiles({
      "imports-sqs.ts": `import { SQSClient } from "@aws-sdk/client-sqs"; export const x = 1;`,
      "no-imports.ts": "export const y = 2;",
    });

    const result = computePackApplicability([importsSqs, noImports], [sqsPack]);
    expect(result.get(importsSqs)).toEqual([sqsPack]);
    expect(result.get(noImports)).toBeUndefined();
  });

  it("matches sub-paths of the gated module (prefix match)", () => {
    const sqsPack = basePack({
      name: "sqs",
      requiresImport: ["@aws-sdk/client-sqs"],
      invocationRecognizers: [noopInvocation],
    });
    const [importsSubpath] = makeFiles({
      "subpath.ts": `import { SendMessageCommand } from "@aws-sdk/client-sqs/dist/types"; export const z = 1;`,
    });
    const result = computePackApplicability([importsSubpath], [sqsPack]);
    expect(result.get(importsSubpath)).toEqual([sqsPack]);
  });

  it("recognizer-only pack WITHOUT requiresImport stays ungated (every file)", () => {
    const nodeRuntimePack = basePack({
      name: "node",
      // No requiresImport — the process surface is a Node.js global
      accessRecognizers: [noopAccess],
    });
    const [file1, file2] = makeFiles({
      "f1.ts": "export const a = 1;",
      "f2.ts": `import x from "y"; export const b = 2;`,
    });

    const result = computePackApplicability([file1, file2], [nodeRuntimePack]);
    expect(result.get(file1)).toEqual([nodeRuntimePack]);
    expect(result.get(file2)).toEqual([nodeRuntimePack]);
  });

  it("gates accessRecognizer-only packs the same as invocation-only", () => {
    const dotenvPack = basePack({
      name: "dotenv",
      requiresImport: ["dotenv"],
      accessRecognizers: [noopAccess],
    });
    const [importsDotenv, noImports] = makeFiles({
      "dotenv.ts": `import dotenv from "dotenv"; export const c = 1;`,
      "plain.ts": "export const d = 2;",
    });

    const result = computePackApplicability(
      [importsDotenv, noImports],
      [dotenvPack],
    );
    expect(result.get(importsDotenv)).toEqual([dotenvPack]);
    expect(result.get(noImports)).toBeUndefined();
  });

  it("multiple packs with different gates: each independently filtered", () => {
    const sqsPack = basePack({
      name: "sqs",
      requiresImport: ["@aws-sdk/client-sqs"],
      invocationRecognizers: [noopInvocation],
    });
    const prismaPack = basePack({
      name: "prisma",
      requiresImport: ["@prisma/client"],
      invocationRecognizers: [noopInvocation],
    });
    const [sqsFile, prismaFile, bothFile] = makeFiles({
      "sqs.ts": `import { SQSClient } from "@aws-sdk/client-sqs";`,
      "prisma.ts": `import { PrismaClient } from "@prisma/client";`,
      "both.ts": `import { SQSClient } from "@aws-sdk/client-sqs";
       import { PrismaClient } from "@prisma/client";`,
    });

    const result = computePackApplicability(
      [sqsFile, prismaFile, bothFile],
      [sqsPack, prismaPack],
    );
    expect(result.get(sqsFile)).toEqual([sqsPack]);
    expect(result.get(prismaFile)).toEqual([prismaPack]);
    expect(
      result.get(bothFile)?.sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([prismaPack, sqsPack]);
  });
});

describe("computePackApplicability with the fact layer", () => {
  function projectOf(files: Record<string, string>): Project {
    const project = createTestProject();
    for (const [path, source] of Object.entries(files)) {
      project.createSourceFile(path, source);
    }
    return project;
  }

  it("applies a pack to a file that reaches the gate through a barrel", () => {
    const sqsPack = basePack({
      name: "sqs",
      requiresImport: ["@aws-sdk/client-sqs"],
      invocationRecognizers: [noopInvocation],
    });
    const project = projectOf({
      "/aws/sqs.ts": `export { SendMessageCommand } from "@aws-sdk/client-sqs";`,
      "/service.ts": `import { SendMessageCommand } from "./aws/sqs";`,
      "/unrelated.ts": "export const x = 1;",
    });
    const files = project.getSourceFiles();
    const service = project.getSourceFileOrThrow("/service.ts");
    const unrelated = project.getSourceFileOrThrow("/unrelated.ts");

    const withoutFacts = computePackApplicability(files, [sqsPack]);
    expect(withoutFacts.get(service)).toBeUndefined();

    const withFacts = computePackApplicability(
      files,
      [sqsPack],
      new ResolutionStore(),
    );
    expect(withFacts.get(service)).toEqual([sqsPack]);
    expect(withFacts.get(unrelated)).toBeUndefined();
  });
});
