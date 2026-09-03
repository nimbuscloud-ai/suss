/**
 * Evidence for drafting a project-wrapper dependency stub: every
 * import, anywhere in the project, of the asked module or one of its
 * submodules. A Python decorator pattern matches a wrapper's import
 * module exactly (see discovery.ts's `importModule.includes`), so a
 * stub covers one imported module at a time rather than one package,
 * and this groups by the exact module text a project writes.
 *
 * This walks every node rather than going through the binder in
 * scope.ts, so an import inside an `if` or `try` still counts as
 * evidence even though the binder would not resolve a name through it.
 */

import fs from "node:fs";
import path from "node:path";

import { field, fields, rangeOf } from "./ast.js";
import { parsePython } from "./parser.js";
import { findPythonFiles } from "./project.js";

import type { PyNode } from "./parser.js";

export interface PythonImportSite {
  /** The name imported at this site, null for a bare `import module`, which binds the whole module rather than one name from it. */
  name: string | null;
  file: string;
  line: number;
}

export interface PythonImportEvidence {
  /** The full dotted module text, exactly as a stub's `package` would spell it. */
  module: string;
  sites: PythonImportSite[];
}

export interface PythonImportEvidenceOptions {
  packageName: string;
  directory: string;
}

function importsSubmoduleOf(module: string, packageName: string): boolean {
  return module === packageName || module.startsWith(`${packageName}.`);
}

/** The dotted modules an `import` statement names, one per comma-separated name. */
function importStatementModules(stmt: PyNode): string[] {
  const modules: string[] = [];
  for (const nameNode of fields(stmt, "name")) {
    if (nameNode.type === "aliased_import") {
      const dotted = field(nameNode, "name");
      if (dotted !== null) {
        modules.push(dotted.text);
      }
      continue;
    }
    if (nameNode.type === "dotted_name") {
      modules.push(nameNode.text);
    }
  }
  return modules;
}

/** The module and imported name of each `from module import name`. Relative imports are skipped, since they never name an installed package. */
function importFromStatementEntries(
  stmt: PyNode,
): { module: string; name: string }[] {
  const moduleNode = field(stmt, "module_name");
  if (moduleNode === null || moduleNode.type === "relative_import") {
    return [];
  }
  const module = moduleNode.text;
  const entries: { module: string; name: string }[] = [];
  for (const nameNode of fields(stmt, "name")) {
    if (nameNode.type === "aliased_import") {
      const original = field(nameNode, "name");
      if (original !== null) {
        entries.push({ module, name: original.text });
      }
      continue;
    }
    if (nameNode.type === "dotted_name") {
      entries.push({ module, name: nameNode.text });
    }
  }
  return entries;
}

function importSitesIn(
  root: PyNode,
): { module: string; name: string | null; line: number }[] {
  const found: { module: string; name: string | null; line: number }[] = [];

  const visit = (node: PyNode): void => {
    if (node.type === "import_statement") {
      const line = rangeOf(node).start;
      for (const module of importStatementModules(node)) {
        found.push({ module, name: null, line });
      }
    } else if (node.type === "import_from_statement") {
      const line = rangeOf(node).start;
      for (const entry of importFromStatementEntries(node)) {
        found.push({ module: entry.module, name: entry.name, line });
      }
    }

    for (const child of node.namedChildren) {
      if (child !== null) {
        visit(child);
      }
    }
  };

  visit(root);
  return found;
}

/**
 * Every import of `packageName`, or a submodule of it, across the
 * project's own files, grouped by the exact module each was imported
 * from.
 */
export async function pythonImportEvidence(
  options: PythonImportEvidenceOptions,
): Promise<PythonImportEvidence[]> {
  const byModule = new Map<string, PythonImportSite[]>();
  for (const file of findPythonFiles(options.directory)) {
    const source = fs.readFileSync(file, "utf8");
    const tree = await parsePython(source);
    const displayPath = path.relative(options.directory, file);
    for (const site of importSitesIn(tree.rootNode)) {
      if (!importsSubmoduleOf(site.module, options.packageName)) {
        continue;
      }
      const sites = byModule.get(site.module) ?? [];
      sites.push({ name: site.name, file: displayPath, line: site.line });
      byModule.set(site.module, sites);
    }
  }

  return [...byModule.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, sites]) => ({ module, sites }));
}
