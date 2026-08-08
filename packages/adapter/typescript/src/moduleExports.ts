import { Node } from "ts-morph";

import {
  importedFilePathsOf,
  loadImportGraphDepthFirst,
} from "./bootstrap/lazyProjectInit.js";
import { createPerFileCache } from "./perFileCache.js";

import type {
  ImportDeclaration,
  Project,
  SourceFile,
  Symbol as TsSymbol,
} from "ts-morph";

type ExportedDeclarationMap = ReturnType<SourceFile["getExportedDeclarations"]>;

/**
 * What a module exports, by exported name.
 *
 * ts-morph rebuilds this map from scratch on every `getExportedDeclarations`
 * call, walking the file's export symbols and following each alias through
 * the type checker. Callee resolution asks the same file the same question
 * once per import site, so the answer is kept for as long as the parse it
 * was read out of.
 */
export function exportedDeclarationsOf(
  sourceFile: SourceFile,
): ExportedDeclarationMap {
  const cached = exportsByFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }

  const declarations = readExportedDeclarations(sourceFile);
  exportsByFile.set(sourceFile, declarations);
  return declarations;
}

const exportsByFile = createPerFileCache<ExportedDeclarationMap>();

/**
 * `Symbol.getAliasedSymbol` behind re-export warming, so an import at
 * the top of a deep re-export chain resolves at any depth instead of
 * overflowing the call stack. A chain the warmed checker still cannot
 * follow answers undefined, the answer an unresolvable alias gives.
 */
export function resolveAliasedSymbol(symbol: TsSymbol): TsSymbol | undefined {
  // Warming the file the alias is written in loads the modules it
  // names and resolves the chain under it. Following an import is what
  // this is, so the imports are the part to resolve from the far end.
  for (const declaration of symbol.getDeclarations()) {
    warmReExportChains(declaration.getSourceFile(), "every import");
  }

  try {
    return symbol.getAliasedSymbol();
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    // This one did fail, and undefined is indistinguishable from an
    // import that names nothing, so the run has to be told.
    for (const declaration of symbol.getDeclarations()) {
      reportUnreadableExports(declaration.getSourceFile());
    }
    return undefined;
  }
}

/**
 * Resolve the alias chains under each of these files now.
 *
 * Discovery reaches an import chain by resolving the symbol a handler
 * came from, which is the checker doing the same recursive descent
 * from the other side, and it gets there before anything asks a module
 * what it exports. Doing every walked file up front means whatever
 * asks next, at either end, finds the hop below it already resolved.
 */
export function warmExportChains(files: ReadonlyArray<SourceFile>): void {
  for (const file of files) {
    warmReExportChains(file, "every import");
  }
}

/**
 * The exported-declarations map, warmed first so the checker never has
 * to recurse a whole re-export chain, and an abstention instead of a
 * crash for a chain it cannot follow even then.
 */
function readExportedDeclarations(
  sourceFile: SourceFile,
): ExportedDeclarationMap {
  warmReExportChains(sourceFile);
  try {
    return sourceFile.getExportedDeclarations();
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }

    reportUnreadableExports(sourceFile);
    return new Map();
  }
}

/**
 * Resolve the alias chains under a file starting from the far end.
 *
 * The checker resolves `export { x } from "./next"` by recursing into
 * the next hop, so the first ask about the top of a deep re-export
 * chain carries the whole chain on the call stack, and a barrel chain
 * deep enough overflows it. This walks the re-export graph below the
 * file on an explicit stack instead, and resolves each file's aliases
 * only after every file it re-exports from is done, so each checker
 * call finds the hop below it already cached and returns without
 * recursing. The visited set ends a chain that loops back on itself:
 * the checker answers a re-export cycle with no declarations, which is
 * what a cycle exports.
 *
 * Loading comes first, because asking the checker about a module that
 * is not loaded yet makes it discover the chain by its own recursion
 * before any of this runs.
 */
function warmReExportChains(
  root: SourceFile,
  reach: Reach = "re-exports",
): void {
  if (warmedFiles.get(root) !== undefined) {
    return;
  }

  if (sitsOnWarmChains(root)) {
    // One hop from answers the checker already has, which is the depth
    // it handles by itself. On a project where hundreds of entry points
    // share one deep core, this is every entry point but the first.
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
    // Warming is preparation. Failing to get ahead of the checker is
    // not the same as failing to answer, and the ask that follows
    // often resolves the same name by a route this walk never took.
    // Whether anything was lost is decided where the asking happens.
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

/**
 * Whether everything this file imports is already resolved.
 *
 * Read from the load walk's own record of what each file imports, so
 * the question costs two map lookups and never touches the checker.
 * Asking it any other way would cost more than warming the file.
 */
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

/**
 * Files this run has resolved, by path. The per-parse record answers
 * "is this SourceFile warm"; this answers "is the file at this path
 * warm", which is what a caller holding only a path can ask.
 */
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
 * How much of a file to resolve ahead of time.
 *
 * Reading a module's exports only needs the aliases those exports are
 * written from. Discovery arrives from the other side, following what
 * a handler imported, so a run that had to load the graph itself
 * resolves every import as well. Doing that everywhere costs far more
 * than it saves on a project whose files were loaded up front.
 */
type Reach = "re-exports" | "every import";

interface ReExportShape {
  /** Files this file re-exports from, directly or through a local import. */
  targets: SourceFile[];
  /** Alias declarations to resolve, dependencies before dependents. */
  aliasNodes: Node[];
}

/**
 * The alias surface of one file, read from syntax alone: which files
 * its imports and re-exports reach into, and which declarations carry
 * them. Import bindings come before export specifiers in the
 * resolution order because `export { x }` resolves through the local
 * import that bound `x`.
 *
 * Which imports count depends on what is being asked. Reading exports
 * needs only the imports those exports re-export; following an import
 * needs all of them, because what a handler imported is what discovery
 * follows into the same chain from the other side.
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
    // A binding an export re-exports has to be resolved before that
    // export is; the rest are resolved here because something else
    // will ask about them later, and this is where it is cheap.
    const reExported = bindings.filter((b) => localNames.has(b.name));
    const rest = bindings.filter((b) => !localNames.has(b.name));
    importNodes.push(...[...reExported, ...rest].map((b) => b.node));
  }

  return { targets, aliasNodes: [...importNodes, ...exportNodes] };
}

/** The local names an import declaration binds, with their nodes. */
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
 * Ask the checker to resolve each alias now, while everything under it
 * is cached. A throw that is not the stack running out surfaces again
 * from the caller's own ask, which is where it is handled.
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
      // One alias this walk could not get ahead of. The caller that
      // wants it will find out for itself.
    }
  }
}

/**
 * Files whose exports could not be read, so the run can say so.
 *
 * A provider whose exports the checker could not follow otherwise
 * looks exactly like a provider that exports nothing: same empty map,
 * same absent summaries, same exit code. The extraction report reads
 * this back and states it, since stderr is not part of the artifact
 * anyone checks later.
 */
export function unreadableExportFiles(): string[] {
  return [...filesWithUnreadableExports].sort();
}

export function forgetUnreadableExportFiles(): void {
  filesWithUnreadableExports.clear();
}

/**
 * Record that a file's modules could not be followed, from outside
 * this module. The chain that outran the stack while a file's exports
 * were being read outruns it again when a pack walks the same file, and
 * a run that says so and carries on beats a run that dies holding the
 * summaries it already built.
 */
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
