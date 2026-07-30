// extract.ts — run the real suss pipeline over a generated module.
//
// One in-memory ts-morph project is shared across calls, with the
// single source file overwritten per program: project bootstrap
// dominates cost (~500ms) while a re-extract over fresh content is
// ~5–30ms, and the differential wants hundreds of programs per run.
// A fresh adapter per call keeps adapter-level caching out of the
// trust chain — only the ts-morph Project object is reused.

import { Project } from "ts-morph";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

let sharedProject: Project | null = null;

function getProject(): Project {
  if (sharedProject === null) {
    sharedProject = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        strict: true,
        target: 99, // ESNext
        module: 99, // ESNext
        moduleResolution: 100, // Bundler
        skipLibCheck: true,
      },
    });
  }
  return sharedProject;
}

export async function extractHandlerSummary(
  moduleSource: string,
  pack: PatternPack,
): Promise<BehavioralSummary> {
  const project = getProject();
  project.createSourceFile("/generated/handler.ts", moduleSource, {
    overwrite: true,
  });

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [pack],
    includeReachable: false,
  });

  const summaries = await adapter.extractAll();
  const handler = summaries.find((summary) => summary.kind === "handler");
  if (handler === undefined) {
    throw new Error(
      `extraction produced no handler summary (${summaries.length} summaries total) for module:\n${moduleSource}`,
    );
  }
  return handler;
}
