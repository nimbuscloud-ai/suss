// A pack that finds units by where a file sits, and what the adapter
// does with a file that sits somewhere else.

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "./../adapter.js";
import { discoverFileConventions } from "./fileConvention.js";

import type { PatternPack } from "@suss/extractor";

const ROUTE_FILES = "**/app/**/route.ts";

function packFinding(
  filePattern: string,
  bindingExtraction: PatternPack["discovery"][number]["bindingExtraction"],
): PatternPack {
  return {
    name: "convention-test",
    protocol: "http",
    languages: ["typescript"],
    discovery: [
      {
        kind: "handler",
        match: { type: "fileConvention", filePattern, exportNames: ["GET"] },
        ...(bindingExtraction !== undefined ? { bindingExtraction } : {}),
      },
    ],
    terminals: [
      {
        kind: "response",
        match: { type: "returnStatement" },
        extraction: { defaultStatusCode: 200 },
      },
    ],
    inputMapping: { type: "positionalParams", params: [] },
  };
}

const SOURCE = `export function GET() {
  return { ok: true };
}`;

async function bindingFor(
  filePath: string,
  pack: PatternPack,
): Promise<unknown> {
  const project = createTestProject();
  project.createSourceFile(filePath, SOURCE);
  const adapter = createTypeScriptAdapter({ project, frameworks: [pack] });
  const summaries = await adapter.extractAll();
  return summaries[0]?.identity.boundaryBinding;
}

describe("discoverFileConventions", () => {
  it("skips a file the pattern does not name", () => {
    const project = createTestProject();
    const file = project.createSourceFile("/src/lib/helpers.ts", SOURCE);
    expect(
      discoverFileConventions(
        file,
        {
          type: "fileConvention",
          filePattern: ROUTE_FILES,
          exportNames: ["GET"],
        },
        "handler",
      ),
    ).toEqual([]);
  });

  it("finds the exports in a file the pattern names", () => {
    const project = createTestProject();
    const file = project.createSourceFile("/src/app/api/route.ts", SOURCE);
    const found = discoverFileConventions(
      file,
      {
        type: "fileConvention",
        filePattern: ROUTE_FILES,
        exportNames: ["GET"],
      },
      "handler",
    );
    expect(found.map((u) => u.name)).toEqual(["GET"]);
  });

  it("reuses the matcher it compiled for a pattern it has seen", () => {
    const project = createTestProject();
    const match = {
      type: "fileConvention" as const,
      filePattern: ROUTE_FILES,
      exportNames: ["GET"],
    };
    const first = project.createSourceFile("/src/app/a/route.ts", SOURCE);
    const second = project.createSourceFile("/src/app/b/route.ts", SOURCE);
    expect(discoverFileConventions(first, match, "handler")).toHaveLength(1);
    expect(discoverFileConventions(second, match, "handler")).toHaveLength(1);
  });
});

describe("a route the file cannot supply", () => {
  it("leaves a unit unbound when its file sits outside the root", async () => {
    // The pattern still matches, since a project can keep an app
    // directory anywhere, but the convention names a different root.
    const pack = packFinding(ROUTE_FILES, {
      method: { type: "fromExportName" },
      path: { type: "fromFilename", root: "pages" },
    });
    expect(await bindingFor("/src/app/api/route.ts", pack)).toEqual({
      transport: "http",
      semantics: { name: "function-call" },
      recognition: "convention-test",
    });
  });

  it("leaves a unit unbound when nothing says which method it answers", async () => {
    const pack = packFinding(ROUTE_FILES, {
      // A method read off a registration call, which a file-routed unit
      // does not have.
      method: { type: "fromRegistration", position: "methodName" },
      path: { type: "fromFilename", root: "app" },
    });
    expect(await bindingFor("/src/app/api/route.ts", pack)).toEqual({
      transport: "http",
      semantics: { name: "function-call" },
      recognition: "convention-test",
    });
  });
});
