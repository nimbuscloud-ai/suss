// extract.ts: run the real suss pipeline over a generated module.
//
// One in-memory ts-morph project is shared per module path, with the
// source file overwritten per program: project bootstrap dominates
// cost (~500ms) while a re-extract over fresh content is ~5, 30ms, and
// the differential wants hundreds of programs per run. A fresh adapter
// per call keeps adapter-level caching out of the trust chain, only
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
  /**
   * One pack, or several when a family needs a pack that discovers
   * units and another that recognizes what happens inside them.
   */
  pack: PatternPack | PatternPack[];
  /**
   * Whether to follow calls out of a discovered unit. A read that sits
   * in a helper is only visible this way, and the runtime packs are the
   * families that care.
   */
  includeReachable?: boolean;
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
    frameworks: Array.isArray(options.pack) ? options.pack : [options.pack],
    includeReachable: options.includeReachable ?? false,
  });
  return adapter.extractAll();
}

export interface ExtractFromDiskOptions {
  /**
   * Absolute path to source, for every TypeScript file the program
   * spans. A family lands here when a pack reads something off the
   * filesystem, a deployment template or a package manifest, and the
   * files have to be where that reader looks.
   */
  files: Record<string, string>;
  pack: PatternPack | PatternPack[];
}

/**
 * Every summary a program on disk produces. One project per set of
 * paths is reused, since the bootstrap dominates and the content is
 * replaced per program.
 */
export async function extractFromDisk(
  options: ExtractFromDiskOptions,
): Promise<BehavioralSummary[]> {
  const paths = Object.keys(options.files).sort();
  const project = getDiskProject(paths.join("|"));
  for (const [filePath, content] of Object.entries(options.files)) {
    project.createSourceFile(filePath, content, { overwrite: true });
  }

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: Array.isArray(options.pack) ? options.pack : [options.pack],
    includeReachable: false,
  });
  return adapter.extractAll();
}

const diskProjects = new Map<string, Project>();

function getDiskProject(key: string): Project {
  const existing = diskProjects.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: true,
      target: 99, // ESNext
      module: 99, // ESNext
      moduleResolution: 100, // Bundler
      skipLibCheck: true,
    },
  });
  diskProjects.set(key, project);
  return project;
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
