// Running a pack over a snippet, the way extraction runs it. The README
// beside this file says what each pack used to write by hand, and why
// the walk here is the one part that is not the adapter's.

import { Node } from "ts-morph";

import {
  accessContextFor,
  invocationContextFor,
  ResolutionStore,
} from "@suss/adapter-typescript";
import { createTestProject } from "@suss/test-project";

import type { Effect } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";
import type { Project, SourceFile } from "ts-morph";

/** Where a snippet goes when the test does not say. */
const DEFAULT_ENTRY = "/repo.ts";

export interface PackHarnessOptions {
  /**
   * The type declarations of each client library to put on disk, keyed
   * by the module name a snippet imports.
   */
  library?: Record<string, string>;
  /**
   * The path a snippet is written to. Set it when a fixture reaches the
   * snippet, or something beside it, by a relative path.
   */
  entry?: string;
}

/** A pack, ready to be asked what it makes of a piece of code. */
export interface PackHarness {
  /** The effects the pack emits over one snippet. */
  effectsIn(source: string): Effect[];
  /** The same when the snippet needs company, and which file to run over. */
  effectsAcross(files: Record<string, string>, entry: string): Effect[];
}

/**
 * The pack comes in built, so a test that varies the pack's own options
 * builds a harness for each set.
 */
export function packUnderTest(
  pack: PatternPack,
  options: PackHarnessOptions = {},
): PackHarness {
  const effectsAcross = (
    files: Record<string, string>,
    entry: string,
  ): Effect[] => {
    const project = createTestProject();
    writeLibraries(project, options.library ?? {});
    return effectsOver(writeFiles(project, files, entry), pack);
  };

  return {
    effectsIn: (source) => {
      const entry = options.entry ?? DEFAULT_ENTRY;
      return effectsAcross({ [entry]: source }, entry);
    },
    effectsAcross,
  };
}

/**
 * Each library as a package the compiler resolves: the declarations,
 * and the package.json that points at them.
 */
function writeLibraries(
  project: Project,
  library: Record<string, string>,
): void {
  for (const [module, declarations] of Object.entries(library)) {
    const root = `/node_modules/${module}`;
    project.createSourceFile(
      `${root}/package.json`,
      JSON.stringify({ name: module, types: "index.d.ts" }),
    );
    project.createSourceFile(`${root}/index.d.ts`, declarations);
  }
}

function writeFiles(
  project: Project,
  files: Record<string, string>,
  entry: string,
): SourceFile {
  let entryFile: SourceFile | undefined;
  for (const [filePath, contents] of Object.entries(files)) {
    const file = project.createSourceFile(filePath, contents);
    if (filePath === entry) {
      entryFile = file;
    }
  }
  if (entryFile === undefined) {
    const given = Object.keys(files).join(", ");
    throw new Error(
      `the entry "${entry}" is not among the files given: ${given}`,
    );
  }
  return entryFile;
}

function effectsOver(sourceFile: SourceFile, pack: PatternPack): Effect[] {
  const invocations = pack.invocationRecognizers ?? [];
  const accesses = pack.accessRecognizers ?? [];
  if (invocations.length === 0 && accesses.length === 0) {
    throw new Error(
      `the pack "${pack.name}" declares no recognizers, so there is nothing to run`,
    );
  }
  const store = new ResolutionStore();
  const resolve = (value: Node): Node | null =>
    store.resolveWrittenValue(value);
  const originatesFrom = (value: Node, module: string): boolean =>
    store.importOriginsOf(value, [module]).length > 0;
  const anchors = (value: Node, matches: (call: Node) => boolean): Node[] =>
    store.anchorCallsOf(value, matches);
  const effects: Effect[] = [];
  sourceFile.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      collect(
        effects,
        invocations,
        node,
        invocationContextFor(node, resolve, originatesFrom, anchors),
      );
    }
    // The access walk reaches a tagged template as well, which is how a
    // statement written as one is read at all.
    if (
      Node.isPropertyAccessExpression(node) ||
      Node.isCallExpression(node) ||
      Node.isTaggedTemplateExpression(node)
    ) {
      collect(
        effects,
        accesses,
        node,
        accessContextFor(node, sourceFile, resolve, originatesFrom, anchors),
      );
    }
  });
  return effects;
}

/** What one set of recognizers makes of one node. */
function collect(
  effects: Effect[],
  recognizers: ReadonlyArray<(node: Node, ctx: unknown) => Effect[] | null>,
  node: Node,
  ctx: unknown,
): void {
  for (const recognizer of recognizers) {
    const emitted = recognizer(node, ctx);
    if (emitted !== null) {
      effects.push(...emitted);
    }
  }
}
