import { Node, SyntaxKind } from "ts-morph";

import { createPerFileCache } from "./perFileCache.js";

import type {
  ImportDeclaration,
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
  for (const declaration of symbol.getDeclarations()) {
    const target = moduleTargetOf(declaration);
    if (target !== undefined) {
      warmReExportChains(target);
    }
  }

  try {
    return symbol.getAliasedSymbol();
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    return undefined;
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

    warnChainTooDeep(sourceFile);
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
 */
function warmReExportChains(root: SourceFile): void {
  if (warmedFiles.get(root) !== undefined) {
    return;
  }

  const visited = new Set<string>([root.getFilePath()]);
  const stack: WalkFrame[] = [frameOf(root)];
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
      stack.push(frameOf(target));
      continue;
    }

    stack.pop();
    warmFileAliases(top.file, top.shape.aliasNodes);
    warmedFiles.set(top.file, true);
  }
}

const warmedFiles = createPerFileCache<true>();

interface WalkFrame {
  file: SourceFile;
  shape: ReExportShape;
  next: number;
}

function frameOf(file: SourceFile): WalkFrame {
  return { file, shape: reExportShapeOf(file), next: 0 };
}

interface ReExportShape {
  /** Files this file re-exports from, directly or through a local import. */
  targets: SourceFile[];
  /** Alias declarations to resolve, dependencies before dependents. */
  aliasNodes: Node[];
}

/**
 * The re-export surface of one file, read from syntax alone: which
 * files its exports reach into, and which alias declarations carry
 * them. Import bindings come before export specifiers in the
 * resolution order because `export { x }` resolves through the local
 * import that bound `x`.
 */
function reExportShapeOf(file: SourceFile): ReExportShape {
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
  if (localNames.size > 0) {
    for (const decl of file.getImportDeclarations()) {
      const bound = importBindingsOf(decl).filter((binding) =>
        localNames.has(binding.name),
      );
      if (bound.length === 0) {
        continue;
      }

      const target = decl.getModuleSpecifierSourceFile();
      if (target !== undefined) {
        targets.push(target);
      }
      importNodes.push(...bound.map((binding) => binding.node));
    }
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
function warmFileAliases(file: SourceFile, aliasNodes: Node[]): void {
  let overflowed = false;
  for (const node of aliasNodes) {
    const symbol = node.getSymbol();
    if (symbol === undefined || !symbol.isAlias()) {
      continue;
    }

    try {
      symbol.getAliasedSymbol();
    } catch (error) {
      if (error instanceof RangeError) {
        overflowed = true;
      }
    }
  }

  if (overflowed) {
    warnChainTooDeep(file);
  }
}

function warnChainTooDeep(file: SourceFile): void {
  process.stderr.write(
    `[suss] Resolving the exports of ${file.getFilePath()} overflowed the call stack, so this run treats what they re-export as resolving to nothing. Units reachable only through them are missing from the results.\n`,
  );
}

/** The file an alias declaration reaches into, when its syntax names one. */
function moduleTargetOf(declaration: Node): SourceFile | undefined {
  if (Node.isImportSpecifier(declaration)) {
    return declaration.getImportDeclaration().getModuleSpecifierSourceFile();
  }

  if (Node.isExportSpecifier(declaration)) {
    return declaration.getExportDeclaration().getModuleSpecifierSourceFile();
  }

  if (Node.isImportClause(declaration) || Node.isNamespaceImport(declaration)) {
    return declaration
      .getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
      ?.getModuleSpecifierSourceFile();
  }
  return undefined;
}
