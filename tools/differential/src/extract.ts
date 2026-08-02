// extract.ts — run the real suss pipeline over a generated module.
//
// One in-memory ts-morph project is shared per module path, with the
// source file overwritten per program: project bootstrap dominates
// cost (~500ms) while a re-extract over fresh content is ~5–30ms, and
// the differential wants hundreds of programs per run. A fresh adapter
// per call keeps adapter-level caching out of the trust chain — only
// the ts-morph Project object is reused.

import { Project } from "ts-morph";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const sharedProjects = new Map<string, Project>();

function getProject(filePath: string): Project {
  const existing = sharedProjects.get(filePath);
  if (existing !== undefined) {
    return existing;
  }
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      target: 99, // ESNext
      module: 99, // ESNext
      moduleResolution: 100, // Bundler
      skipLibCheck: true,
      jsx: 4, // ReactJSX — parses .tsx surfaces; harmless for .ts
    },
  });
  sharedProjects.set(filePath, project);
  return project;
}

export interface ExtractOptions {
  moduleSource: string;
  pack: PatternPack;
  /** In-memory path; its extension drives JSX parsing (.ts vs .tsx). */
  filePath: string;
  /** The summary kind the module is expected to produce. */
  kind: BehavioralSummary["kind"];
}

export async function extractSummary(
  options: ExtractOptions,
): Promise<BehavioralSummary> {
  const project = getProject(options.filePath);
  project.createSourceFile(options.filePath, options.moduleSource, {
    overwrite: true,
  });

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [options.pack],
    includeReachable: false,
  });

  const summaries = await adapter.extractAll();
  const found = summaries.find((summary) => summary.kind === options.kind);
  if (found === undefined) {
    throw new Error(
      `extraction produced no ${options.kind} summary (${summaries.length} summaries total) for module:\n${options.moduleSource}`,
    );
  }
  return found;
}

export interface ExtractAllOptions {
  /** In-memory path to source, for every file the program spans. */
  files: Record<string, string>;
  pack: PatternPack;
}

/**
 * Every summary a multi-file program produces. A shape can span a
 * module, a barrel, and an entry file, and what the oracles check is
 * often the set itself (how many summaries, what they are named,
 * whether two of them collapse), so nothing is filtered here.
 */
export async function extractAllSummaries(
  options: ExtractAllOptions,
): Promise<BehavioralSummary[]> {
  const project = getProject("__multiFile__");
  for (const existing of project.getSourceFiles()) {
    project.removeSourceFile(existing);
  }
  for (const [filePath, content] of Object.entries(options.files)) {
    project.createSourceFile(filePath, content, { overwrite: true });
  }

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [options.pack],
    includeReachable: false,
  });
  return adapter.extractAll();
}

export async function extractHandlerSummary(
  moduleSource: string,
  pack: PatternPack,
): Promise<BehavioralSummary> {
  return extractSummary({
    moduleSource,
    pack,
    filePath: "/generated/handler.ts",
    kind: "handler",
  });
}

export async function extractComponentSummary(
  moduleSource: string,
  pack: PatternPack,
): Promise<BehavioralSummary> {
  return extractSummary({
    moduleSource,
    pack,
    filePath: "/generated/Component.tsx",
    kind: "component",
  });
}
