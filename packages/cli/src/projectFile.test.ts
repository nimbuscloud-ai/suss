import { describe, expect, it } from "vitest";

import {
  projectFileFor,
  readEntryIndex,
  readOutputName,
  unreadArtifacts,
} from "./projectFile.js";

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
  const schema = {
    kind: "contract",
    from: "prisma",
    file: "src/prisma/schema.prisma",
  };
  const labelled = (...labels: string[]) => ({
    labels: new Set(labels),
    entries: new Set<number>(),
  });

  it("names the artifact no summary came from", () => {
    expect(unreadArtifacts(file!, labelled("src/app/routes.ts"))).toEqual([
      schema,
    ]);
  });

  it("stays quiet once the run has read it", () => {
    expect(
      unreadArtifacts(file!, labelled("src/prisma/schema.prisma")),
    ).toEqual([]);
  });

  it("knows a summary a reader labelled with its name and the path from the repository root", () => {
    expect(
      unreadArtifacts(
        file!,
        labelled("prisma:services/shop/src/prisma/schema.prisma"),
      ),
    ).toEqual([]);
  });

  it("knows a summary a reader labelled with the file name alone", () => {
    expect(unreadArtifacts(file!, labelled("schema.prisma"))).toEqual([]);
  });

  it("counts an entry extract --out-dir wrote into the folder as read", () => {
    const index = file!.read.findIndex((entry) => entry.kind === "contract");
    expect(readEntryIndex(readOutputName(index, file!.read[index]!))).toBe(
      index,
    );
    expect(
      unreadArtifacts(file!, {
        labels: new Set(["src/app/routes.ts"]),
        entries: new Set([index]),
      }),
    ).toEqual([]);
  });

  it("gives no entry for a file extract --out-dir did not write", () => {
    expect(readEntryIndex("summaries.json")).toBeNull();
  });
});
