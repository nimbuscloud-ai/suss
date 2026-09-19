import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createFixtureProject, createTestProject } from "@suss/test-project";

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
      // No requiresImport: the process surface is a Node.js global
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

describe("computePackApplicability with a generated module", () => {
  // The marker is a file on disk, so these fixtures cannot be in memory.
  let root: string;
  let project: Project;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-prefilter-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "generated/client"), { recursive: true });
    fs.writeFileSync(path.join(root, "generated/client/schema.prisma"), "");
    fs.writeFileSync(
      path.join(root, "generated/client/index.d.ts"),
      "export declare class PrismaClient {}\n",
    );
    fs.writeFileSync(
      path.join(root, "src/db.ts"),
      `import { PrismaClient } from "../generated/client/index.js";
       export const db = new PrismaClient();`,
    );
    fs.writeFileSync(
      path.join(root, "src/api.ts"),
      `import { db } from "./db.js";
       export const read = () => db;`,
    );
    fs.writeFileSync(
      path.join(root, "src/unrelated.ts"),
      "export const x = 1;",
    );
    project = createFixtureProject(root, "src/*.ts");
  });

  const prismaPack = (): PatternPack =>
    basePack({
      name: "prisma",
      requiresImport: ["@prisma/client"],
      generatedModuleMarkers: ["schema.prisma"],
      invocationRecognizers: [noopInvocation],
    });

  it("applies the pack to the file importing the generated client", () => {
    const pack = prismaPack();
    const files = project.getSourceFiles();
    const db = project.getSourceFileOrThrow(path.join(root, "src/db.ts"));

    expect(computePackApplicability(files, [pack]).get(db)).toEqual([pack]);
  });

  it("applies it to a file reaching the generated client through that module", () => {
    const pack = prismaPack();
    const files = project.getSourceFiles();
    const api = project.getSourceFileOrThrow(path.join(root, "src/api.ts"));
    const unrelated = project.getSourceFileOrThrow(
      path.join(root, "src/unrelated.ts"),
    );

    const applicable = computePackApplicability(
      files,
      [pack],
      new ResolutionStore(),
    );
    expect(applicable.get(api)).toEqual([pack]);
    expect(applicable.get(unrelated)).toBeUndefined();
  });

  it("leaves a pack that declares no marker where it was", () => {
    const pack = basePack({
      name: "prisma",
      requiresImport: ["@prisma/client"],
      invocationRecognizers: [noopInvocation],
    });
    const files = project.getSourceFiles();
    const db = project.getSourceFileOrThrow(path.join(root, "src/db.ts"));

    expect(computePackApplicability(files, [pack]).get(db)).toBeUndefined();
  });
});
