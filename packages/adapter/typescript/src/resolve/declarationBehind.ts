/**
 * Where a value is declared under a name, read from the facts: the
 * declaration a name `binds` to in its own file, or, for a name bound to
 * an import, what the module exports under the imported name, followed
 * through renames and re-exports. The module's exports come from the
 * store's export table, stated only as far as each file's export
 * statements.
 *
 * A member read off a namespace import, `Icons.Star`, already binds to
 * the declaration, since `binds` comes from the checker's symbol for the
 * name. An import whose module is not in the run gives nothing.
 */

import { Node, SyntaxKind } from "ts-morph";

import { nodeId } from "../facts/extract.js";

import type { Declaration } from "@suss/extractor";
import type { ResolutionStore } from "../facts/store.js";

export function declarationBehind(
  value: Node,
  store: ResolutionStore,
): Declaration | null {
  return declarationOfName(value, store, new Set());
}

function declarationOfName(
  value: Node,
  store: ResolutionStore,
  seen: Set<Node>,
): Declaration | null {
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);
  const access = store.factAccess();
  access.state(value);
  for (const row of access.db.lookup("binds", 0, nodeId(value))) {
    const bound = access.nodeOf(String(row[1]));
    if (bound === undefined) {
      continue;
    }
    const imported = access.db.lookup("imports", 0, nodeId(bound));
    const found =
      imported.length > 0
        ? importedDeclaration(bound, imported, store, seen)
        : declared(bound, store, seen);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * What the module the program resolved the import to exports under the
 * imported name. Loading any other file the import's keys spell, such as
 * a `.vue` file a shim types, would make the compiler build its program
 * again for no answer.
 */
function importedDeclaration(
  binding: Node,
  imported: readonly (readonly unknown[])[],
  store: ResolutionStore,
  seen: Set<Node>,
): Declaration | null {
  const module = binding
    .getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
    ?.getModuleSpecifierSourceFile();
  if (module === undefined) {
    return null;
  }
  for (const name of new Set(imported.map((row) => String(row[2])))) {
    for (const exported of store.declarationExportedAs(module, name)) {
      const found = declared(exported, store, seen);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/** A variable, function or class has a name; a name leads on to what it binds to; anything else is declared with no name. */
function declared(
  node: Node,
  store: ResolutionStore,
  seen: Set<Node>,
): Declaration | null {
  if (
    Node.isVariableDeclaration(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isClassDeclaration(node)
  ) {
    return {
      file: node.getSourceFile().getFilePath(),
      name: node.getName() ?? null,
    };
  }
  if (Node.isIdentifier(node)) {
    return declarationOfName(node, store, seen);
  }
  return { file: node.getSourceFile().getFilePath(), name: null };
}
