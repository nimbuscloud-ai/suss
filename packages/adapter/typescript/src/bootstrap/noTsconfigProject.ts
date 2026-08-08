// noTsconfigProject.ts: read a project that has no tsconfig.
//
// Many JavaScript codebases have no tsconfig. The compiler options
// below are the minimum the parser needs to read modern source. Nothing
// here typechecks.

import fs from "node:fs";
import path from "node:path";

import {
  ModuleKind,
  ModuleResolutionKind,
  Project,
  ScriptTarget,
} from "ts-morph";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".git",
  ".turbo",
  ".next",
  ".suss",
  "vendor",
]);

/** Every source file under `rootDir`, skipping build output and dependencies. */
export function findSourceFiles(rootDir: string, depth = 0): string[] {
  // Bounded so the walk cannot dominate the run on a deep tree.
  if (depth > 12) {
    return [];
  }

  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findSourceFiles(full, depth + 1));
    } else if (
      SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
      !entry.name.endsWith(".d.ts")
    ) {
      found.push(full);
    }
  }
  return found;
}

/**
 * A Project covering `rootDir`, for a codebase with no tsconfig to read.
 * Returns the project and the files it loaded.
 */
export function createProjectWithoutTsconfig(rootDir: string): {
  project: Project;
  files: string[];
} {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      target: ScriptTarget.ES2022,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      allowJs: true,
      checkJs: false,
      noEmit: true,
      // Off, because this project was never configured for strictness
      // and the parse should not care.
      strict: false,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      jsx: 4, // ReactJSX, so .jsx and .tsx parse without configuration
    },
  });

  const files = findSourceFiles(rootDir);
  for (const file of files) {
    try {
      project.addSourceFileAtPath(file);
    } catch {
      // Skip a file that will not parse; the rest still extract.
    }
  }
  return { project, files };
}

/** The nearest tsconfig or jsconfig at or above `startDir`, or null. */
export function findNearestTsconfig(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}
