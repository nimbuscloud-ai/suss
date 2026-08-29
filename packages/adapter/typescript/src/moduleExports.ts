import { Node } from "ts-morph";

import {
  importedFilePathsOf,
  loadImportGraphDepthFirst,
} from "./bootstrap/lazyProjectInit.js";
import { recordFileDependency } from "./depTracking.js";
import { createPerFileCache } from "./perFileCache.js";

import type {
  ImportDeclaration,
  Project,
  SourceFile,
  Symbol as TsSymbol,
} from "ts-morph";
import type { ResolutionStore } from "./facts/store.js";

/**
 * What a module exports, by exported name. The store's rules flatten
 * re-export chains of any length, and the store memoizes per file.
 */
export function exportedDeclarationsOf(
  sourceFile: SourceFile,
  resolution: ResolutionStore,
): Map<string, Node[]> {
  return resolution.exportsOf(sourceFile);
}

/**
 * `Symbol.getAliasedSymbol`, with the re-export chains warmed first so
 * that an import sitting at the top of a deep chain still resolves
 * instead of running the call stack out.
 */
export function resolveAliasedSymbol(symbol: TsSymbol): TsSymbol | undefined {
  for (const declaration of symbol.getDeclarations()) {
    warmReExportChains(declaration.getSourceFile(), "every import");
  }

  try {
    const aliased = symbol.getAliasedSymbol();
    // Whoever is collecting file dependencies read the file the alias
    // lands in, not only the file the import is written in.
    for (const declaration of aliased?.getDeclarations() ?? []) {
      const file = declaration.getSourceFile();
      if (!file.isInNodeModules()) {
        recordFileDependency(file.getFilePath());
      }
    }
    return aliased;
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    // Returning undefined here looks exactly like an import that points
    // at nothing, so record the file or the run reports the two the same
    // way.
    for (const declaration of symbol.getDeclarations()) {
      reportUnreadableExports(declaration.getSourceFile());
    }
    return undefined;
  }
}

export function warmExportChains(files: ReadonlyArray<SourceFile>): void {
  for (const file of files) {
    warmReExportChains(file, "every import");
  }
}

/**
 * Load the graph before warming it. If the checker is asked about a
 * module it has not loaded yet, it goes and finds the whole chain by
 * recursing, which is the stack overflow this is meant to avoid.
 */
function warmReExportChains(
  root: SourceFile,
  reach: Reach = "re-exports",
): void {
  if (warmedFiles.get(root) !== undefined) {
    return;
  }

  if (sitsOnWarmChains(root)) {
    // Everything this file imports is already warm, so the checker only
    // has one hop left to make and can do that on its own.
    markWarmed(root);
    return;
  }

  try {
    loadImportGraphDepthFirst(root);
    walkAndWarm(root, reach);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    // Warming only makes the later lookup cheaper, so give up quietly
    // and let that lookup report if it also fails.
  }
}

function walkAndWarm(root: SourceFile, reach: Reach): void {
  const visited = new Set<string>([root.getFilePath()]);
  const stack: WalkFrame[] = [frameOf(root, reach)];
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as WalkFrame;
    const target = top.shape.targets[top.next];
    if (target !== undefined) {
      top.next += 1;
      if (warmedFiles.get(target) !== undefined) {
        continue;
      }

      const path = target.getFilePath();
      if (visited.has(path)) {
        continue;
      }

      visited.add(path);
      stack.push(frameOf(target, reach));
      continue;
    }

    stack.pop();
    warmFileAliases(top.shape.aliasNodes);
    markWarmed(top.file);
  }
}

const warmedFiles = createPerFileCache<true>();

/** Uses the load walk's record rather than the checker, which is slower. */
function sitsOnWarmChains(file: SourceFile): boolean {
  const project = file.getProject();
  const warmed = warmedPathsIn(project);
  if (warmed.size === 0) {
    return false;
  }

  const imported = importedFilePathsOf(project, file.getFilePath());
  return imported.length > 0 && imported.every((path) => warmed.has(path));
}

function markWarmed(file: SourceFile): void {
  warmedFiles.set(file, true);
  warmedPathsIn(file.getProject()).add(file.getFilePath());
}

function warmedPathsIn(project: Project): Set<string> {
  const existing = warmedPathsByProject.get(project);
  if (existing !== undefined) {
    return existing;
  }

  const fresh = new Set<string>();
  warmedPathsByProject.set(project, fresh);
  return fresh;
}

const warmedPathsByProject = new WeakMap<Project, Set<string>>();

interface WalkFrame {
  file: SourceFile;
  shape: ReExportShape;
  next: number;
}

function frameOf(file: SourceFile, reach: Reach): WalkFrame {
  return { file, shape: reExportShapeOf(file, reach), next: 0 };
}

/**
 * How much of a file to warm. Reading a module's exports only needs the
 * aliases those exports are written from; following a handler's import
 * needs every alias in the file.
 */
type Reach = "re-exports" | "every import";

interface ReExportShape {
  /** Files this file re-exports from, directly or through a local import. */
  targets: SourceFile[];
  /** Alias declarations to resolve, dependencies before dependents. */
  aliasNodes: Node[];
}

/**
 * The files this one re-exports from, and the aliases to resolve. Import
 * bindings come before export specifiers, because `export { x }`
 * resolves through the local import that bound `x`.
 */
function reExportShapeOf(file: SourceFile, reach: Reach): ReExportShape {
  const targets: SourceFile[] = [];
  const exportNodes: Node[] = [];
  const localNames = new Set<string>();

  for (const decl of file.getExportDeclarations()) {
    const target = decl.getModuleSpecifierSourceFile();
    if (target !== undefined) {
      targets.push(target);
    }

    for (const named of decl.getNamedExports()) {
      exportNodes.push(named);
      if (decl.getModuleSpecifier() === undefined) {
        localNames.add(named.getName());
      }
    }
  }

  for (const assignment of file.getExportAssignments()) {
    exportNodes.push(assignment);
    const expression = assignment.getExpression();
    if (Node.isIdentifier(expression)) {
      localNames.add(expression.getText());
    }
  }

  const importNodes: Node[] = [];
  for (const decl of file.getImportDeclarations()) {
    const all = importBindingsOf(decl);
    const bindings =
      reach === "every import"
        ? all
        : all.filter((binding) => localNames.has(binding.name));
    if (bindings.length === 0) {
      continue;
    }

    const target = decl.getModuleSpecifierSourceFile();
    if (target !== undefined) {
      targets.push(target);
    }
    // Within one import declaration, the bindings an export re-exports
    // go first, for the same reason imports go before exports overall.
    const reExported = bindings.filter((b) => localNames.has(b.name));
    const rest = bindings.filter((b) => !localNames.has(b.name));
    importNodes.push(...[...reExported, ...rest].map((b) => b.node));
  }

  return { targets, aliasNodes: [...importNodes, ...exportNodes] };
}

function importBindingsOf(
  decl: ImportDeclaration,
): Array<{ name: string; node: Node }> {
  const bindings: Array<{ name: string; node: Node }> = [];
  const defaultImport = decl.getDefaultImport();
  if (defaultImport !== undefined) {
    bindings.push({ name: defaultImport.getText(), node: defaultImport });
  }

  const namespaceImport = decl.getNamespaceImport();
  if (namespaceImport !== undefined) {
    bindings.push({ name: namespaceImport.getText(), node: namespaceImport });
  }

  for (const named of decl.getNamedImports()) {
    bindings.push({
      name: named.getAliasNode()?.getText() ?? named.getName(),
      node: named,
    });
  }
  return bindings;
}

/**
 * Resolve each alias in a file. The caller has already warmed everything
 * below it, so each of these is one hop rather than a whole chain.
 */
function warmFileAliases(aliasNodes: Node[]): void {
  for (const node of aliasNodes) {
    const symbol = node.getSymbol();
    if (symbol === undefined || !symbol.isAlias()) {
      continue;
    }

    try {
      symbol.getAliasedSymbol();
    } catch (error) {
      if (!(error instanceof RangeError)) {
        throw error;
      }
      // One alias too deep to warm. The rest of the file still warms,
      // and the caller reports if the later lookup fails too.
    }
  }
}

/**
 * The files whose exports could not be read. These also go to stderr,
 * but the extraction report needs them in the artifact, where a later
 * reader can see why something is missing.
 */
export function unreadableExportFiles(): string[] {
  return [...filesWithUnreadableExports].sort();
}

export function forgetUnreadableExportFiles(): void {
  filesWithUnreadableExports.clear();
}

export function noteUnreadableExports(file: SourceFile): void {
  reportUnreadableExports(file);
}

const filesWithUnreadableExports = new Set<string>();

function reportUnreadableExports(file: SourceFile): void {
  const filePath = file.getFilePath();
  if (filesWithUnreadableExports.has(filePath)) {
    return;
  }

  filesWithUnreadableExports.add(filePath);
  process.stderr.write(
    `[suss] Resolving the exports of ${filePath} overflowed the call stack, so this run treats what they re-export as resolving to nothing. Units reachable only through them are missing from the results.\n`,
  );
}
