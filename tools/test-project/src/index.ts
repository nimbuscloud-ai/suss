// The ts-morph Project tests parse fixture source with.
//
// Tests used to construct their own, and 28 different option sets grew up
// across the suite. A test whose target or module resolution differs from
// what the adapter configures is reading a language the tool never sees,
// so a divergence in the adapter can pass every test. The options below
// are the ones the adapter picks for a codebase that ships no tsconfig,
// which is the only set suss itself chooses; a test in the adapter
// asserts the two still agree.
//
// The project is reused across calls because a fresh one costs about
// 70ms, almost all of it parsing lib.d.ts, and the suite asked for one
// per test.

import {
  ModuleKind,
  ModuleResolutionKind,
  Project,
  ScriptTarget,
} from "ts-morph";

import type { CompilerOptions } from "ts-morph";

/** How suss reads source when the codebase gives it nothing to go on. */
export const testCompilerOptions: CompilerOptions = {
  target: ScriptTarget.ES2022,
  module: ModuleKind.ESNext,
  moduleResolution: ModuleResolutionKind.Bundler,
  allowJs: true,
  checkJs: false,
  noEmit: true,
  strict: false,
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
  jsx: 4, // ReactJSX, so .jsx and .tsx parse without configuration
};

let recycled: Project | undefined;

/**
 * An empty in-memory Project reading fixture source the way suss reads a
 * codebase. Everything an earlier caller wrote is gone, including files
 * written straight to the file system, so a caller sees what a fresh
 * project would give it. A caller that keeps its project past the next
 * call gets a ts-morph error off the removed source file rather than a
 * wrong answer.
 */
export function createTestProject(): Project {
  if (recycled === undefined) {
    recycled = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: testCompilerOptions,
    });
    makeTypesRoot(recycled);
    return recycled;
  }

  for (const sourceFile of recycled.getSourceFiles()) {
    recycled.removeSourceFile(sourceFile);
  }
  const host = recycled.getFileSystem();
  // The default libraries live outside the enumerable file system, so
  // emptying the root does not cost the reuse.
  for (const entry of host.readDirSync("/")) {
    host.deleteSync(entry.name);
  }
  makeTypesRoot(recycled);
  // Removing a file and writing a new one at the same path resets its
  // version to zero, and the language service then reads the version as
  // "unchanged" and answers off the file that is gone. Callers name
  // their fixtures the same handful of paths, so this happens
  // constantly; without the flush, `user.id` resolves against the
  // previous test's `user`.
  recycled.getLanguageService().compilerObject.cleanupSemanticCache();
  return recycled;
}

/**
 * The compiler enumerates the @types root while resolving a package that
 * ships its declarations separately, and an in-memory directory only
 * exists once something makes it. A checkout has this directory, so
 * every project here has it too.
 */
function makeTypesRoot(project: Project): void {
  project.getFileSystem().mkdirSync("/node_modules/@types");
}
