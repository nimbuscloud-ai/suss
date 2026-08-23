import { describe, expect, it } from "vitest";

import { projectFileFor, unreadArtifacts } from "./projectFile.js";

import type { InitReport } from "./init.js";

const report = (over: Partial<InitReport> = {}): InitReport => ({
  root: "/project",
  tsconfig: "/project/tsconfig.app.json",
  suggestions: [
    {
      name: "express",
      packageName: "@suss/packs",
      because: "express in dependencies",
      kind: "framework",
      language: "typescript",
    },
    {
      name: "prisma",
      packageName: "@suss/contract-prisma",
      because: "a Prisma schema",
      kind: "contract",
      file: "src/prisma/schema.prisma",
    },
  ],
  ...over,
});

describe("what init writes down", () => {
  it("keeps the packs by language and the artifacts by file", () => {
    expect(projectFileFor(report())).toEqual({
      version: 1,
      read: [
        {
          kind: "extract",
          language: "typescript",
          project: "tsconfig.app.json",
          packs: ["express"],
        },
        { kind: "contract", from: "prisma", file: "src/prisma/schema.prisma" },
      ],
    });
  });

  it("writes nothing for a project with nothing to read", () => {
    expect(projectFileFor(report({ suggestions: [] }))).toBeNull();
  });
});

describe("which artifacts a run missed", () => {
  const file = projectFileFor(report());

  it("names the artifact no summary came from", () => {
    expect(unreadArtifacts(file!, new Set(["src/app/routes.ts"]))).toEqual([
      { kind: "contract", from: "prisma", file: "src/prisma/schema.prisma" },
    ]);
  });

  it("stays quiet once the run has read it", () => {
    expect(
      unreadArtifacts(file!, new Set(["src/prisma/schema.prisma"])),
    ).toEqual([]);
  });
});
