import { Project, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import { computePackApplicability } from "./preFilter.js";

import type {
  AccessRecognizer,
  InvocationRecognizer,
  PatternPack,
} from "@suss/extractor";

const noopInvocation: InvocationRecognizer = () => null;
const noopAccess: AccessRecognizer = () => null;

function makeFile(source: string, name = "src.ts"): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile(name, source);
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
    const importsSqs = makeFile(
      `import { SQSClient } from "@aws-sdk/client-sqs"; export const x = 1;`,
      "imports-sqs.ts",
    );
    const noImports = makeFile("export const y = 2;", "no-imports.ts");

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
    const importsSubpath = makeFile(
      `import { SendMessageCommand } from "@aws-sdk/client-sqs/dist/types"; export const z = 1;`,
      "subpath.ts",
    );
    const result = computePackApplicability([importsSubpath], [sqsPack]);
    expect(result.get(importsSubpath)).toEqual([sqsPack]);
  });

  it("recognizer-only pack WITHOUT requiresImport stays ungated (every file)", () => {
    const processEnvPack = basePack({
      name: "process-env",
      // No requiresImport — process.env is a Node.js global
      accessRecognizers: [noopAccess],
    });
    const file1 = makeFile("export const a = 1;", "f1.ts");
    const file2 = makeFile(`import x from "y"; export const b = 2;`, "f2.ts");

    const result = computePackApplicability([file1, file2], [processEnvPack]);
    expect(result.get(file1)).toEqual([processEnvPack]);
    expect(result.get(file2)).toEqual([processEnvPack]);
  });

  it("gates accessRecognizer-only packs the same as invocation-only", () => {
    const dotenvPack = basePack({
      name: "dotenv",
      requiresImport: ["dotenv"],
      accessRecognizers: [noopAccess],
    });
    const importsDotenv = makeFile(
      `import dotenv from "dotenv"; export const c = 1;`,
      "dotenv.ts",
    );
    const noImports = makeFile("export const d = 2;", "plain.ts");

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
    const sqsFile = makeFile(
      `import { SQSClient } from "@aws-sdk/client-sqs";`,
      "sqs.ts",
    );
    const prismaFile = makeFile(
      `import { PrismaClient } from "@prisma/client";`,
      "prisma.ts",
    );
    const bothFile = makeFile(
      `import { SQSClient } from "@aws-sdk/client-sqs";
       import { PrismaClient } from "@prisma/client";`,
      "both.ts",
    );

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
