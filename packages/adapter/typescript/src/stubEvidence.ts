/**
 * Evidence for drafting a dependency stub: every call the project
 * makes into a named package, grouped by the export it reaches, with
 * the argument shapes observed at each call site. `suss stub draft`
 * turns this into a stub skeleton for an author to fill in. The
 * package's own code is never read, only the project's calls into it,
 * so this works for packages whose source no adapter can parse.
 */

import path from "node:path";

import { Project } from "ts-morph";

import { attributedCalls } from "./discovery/packageImport.js";
import { ResolutionStore } from "./facts/store.js";
import { effectArgOf } from "./resolve/invocationEffects.js";

import type { EffectArg } from "@suss/extractor";

export interface ObservedStubCall {
  readonly file: string;
  readonly line: number;
  readonly args: EffectArg[];
}

export interface StubCallEvidence {
  readonly exportPath: string[];
  readonly calls: ObservedStubCall[];
}

export function stubEvidenceIn(
  project: Project,
  packageName: string,
  root: string,
): StubCallEvidence[] {
  const resolution = new ResolutionStore();
  const byExport = new Map<string, StubCallEvidence>();
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) {
      continue;
    }

    for (const one of attributedCalls(sourceFile, [packageName], resolution)) {
      const key = one.exportPath.join(".");
      const entry = byExport.get(key) ?? {
        exportPath: one.exportPath,
        calls: [],
      };
      entry.calls.push({
        file: path
          .relative(root, sourceFile.getFilePath())
          .split(path.sep)
          .join("/"),
        line: one.call.getStartLineNumber(),
        args: one.call.getArguments().map((arg) => effectArgOf(arg)),
      });
      byExport.set(key, entry);
    }
  }

  return [...byExport.values()].sort((a, b) =>
    a.exportPath.join(".").localeCompare(b.exportPath.join(".")),
  );
}

export interface StubEvidenceOptions {
  packageName: string;
  tsConfigFilePath?: string;
  /** Read when no tsconfig is given. */
  directory?: string;
}

export function stubEvidence(options: StubEvidenceOptions): StubCallEvidence[] {
  const project = new Project(
    options.tsConfigFilePath !== undefined
      ? { tsConfigFilePath: options.tsConfigFilePath }
      : { compilerOptions: { allowJs: true } },
  );
  const root =
    options.tsConfigFilePath !== undefined
      ? path.dirname(options.tsConfigFilePath)
      : path.resolve(options.directory ?? process.cwd());
  if (options.tsConfigFilePath === undefined) {
    project.addSourceFilesAtPaths([
      `${root}/**/*.{ts,tsx,js,jsx}`,
      `!${root}/**/node_modules/**`,
    ]);
  }

  return stubEvidenceIn(project, options.packageName, root);
}
