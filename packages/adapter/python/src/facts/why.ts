/**
 * The session behind `suss ask why` on a Python project: a tree-sitter
 * parse of the asked-about source, a way to point at the expression
 * somebody spelled, and the witness proof of what it resolved to,
 * rendered through `@suss/resolution`'s phrases.
 *
 * It parses every file under the root and emits the same value facts
 * `extractPythonProject` does, keeping a location for every fact key so
 * a proof's atoms can point back at source. A handle this session hands
 * back pairs a tree-sitter node with the file it came from, since a
 * node alone does not say which file parsed it.
 */

import fs from "node:fs";
import path from "node:path";

import { Database } from "@suss/datalog";
import { explainResolvedKey, RESOLUTION_RULES } from "@suss/resolution";

import { enclosingFunction, field, fields, isFunction } from "../ast.js";
import { emitModuleImportFacts } from "../facts.js";
import { parsePythonSync } from "../parser.js";
import { findPythonFiles } from "../project.js";
import { bindModule } from "../scope.js";
import { emitValueFacts, nodeId, readKey } from "./values.js";

import type { ValueLocation, WhyExplained } from "@suss/resolution";
import type { PyNode } from "../parser.js";

export interface PythonWhySessionOptions {
  /** The project root, which paths in every answer come out relative to. */
  dir: string;
}

/** A found node, paired with the file it was parsed from. */
export interface PythonValueHandle {
  file: string;
  node: PyNode;
}

interface Located {
  file: string;
  node: PyNode;
}

const IMPORT_TYPES = new Set(["import_statement", "import_from_statement"]);

function namedChildrenOf(node: PyNode): PyNode[] {
  return node.namedChildren.filter((child): child is PyNode => child !== null);
}

/**
 * The local name an import statement binds, and where it is written:
 * the alias in `import x as y`, the bare name otherwise. Mirrors
 * `scope.ts`'s binder closely enough to say where a name came from,
 * without needing the module path or relative level it also tracks.
 */
function indexImportNames(
  file: string,
  stmt: PyNode,
  locations: Map<string, Located>,
): void {
  for (const nameNode of fields(stmt, "name")) {
    if (nameNode.type === "aliased_import") {
      const alias = field(nameNode, "alias");
      if (alias !== null) {
        locations.set(`${file}#${alias.text}`, { file, node: alias });
      }
      continue;
    }
    const local =
      nameNode.type === "dotted_name" ? nameNode.namedChild(0) : nameNode;
    if (local !== null) {
      locations.set(`${file}#${local.text}`, { file, node: local });
    }
  }
}

/**
 * Every declaration site in a file, indexed under the same key
 * `emitValueFacts` gave it: a function or class by its own node, a
 * name it declares by that name's identifier, so a proof atom that is
 * a bare name still says where it came from.
 */
function indexFile(
  file: string,
  root: PyNode,
  locations: Map<string, Located>,
): void {
  const walk = (node: PyNode): void => {
    locations.set(nodeId(file, node), { file, node });

    if (IMPORT_TYPES.has(node.type)) {
      indexImportNames(file, node, locations);
    }
    if (isFunction(node) || node.type === "class_definition") {
      const name = field(node, "name");
      if (name !== null) {
        locations.set(`${file}#${name.text}`, { file, node: name });
      }
    }
    if (node.type === "assignment") {
      const left = field(node, "left");
      if (left !== null && left.type === "identifier") {
        locations.set(`${file}#${left.text}`, { file, node: left });
      }
    }

    for (const child of namedChildrenOf(node)) {
      walk(child);
    }
  };
  walk(root);
}

/** What to call a node in a sentence. */
function displayNameOf(node: PyNode): string {
  if (node.type === "identifier") {
    return node.text;
  }
  if (node.type === "call") {
    const callee = field(node, "function");
    return `${callee?.text ?? "call"}(...)`;
  }
  if (node.type === "function_definition" || node.type === "class_definition") {
    return field(node, "name")?.text ?? node.text;
  }
  const text = node.text.split("\n")[0].trim();
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

function width(node: PyNode): number {
  return node.endIndex - node.startIndex;
}

export class PythonWhySession {
  private readonly root: string;
  private readonly db = new Database();
  private readonly locations = new Map<string, Located>();
  private readonly trees = new Map<string, PyNode>();

  constructor(options: PythonWhySessionOptions) {
    this.root = path.resolve(options.dir);
    const roots = [this.root];

    for (const file of findPythonFiles(this.root)) {
      const source = fs.readFileSync(file, "utf8");
      const root = parsePythonSync(source).rootNode;
      this.trees.set(file, root);
      emitModuleImportFacts(this.db, file, bindModule(root), { roots });
      emitValueFacts(this.db, file, root);
      indexFile(file, root, this.locations);
    }
  }

  /**
   * The smallest expression on `line` of `file` whose text is exactly
   * `text`, or null.
   */
  findExpression(
    file: string,
    line: number,
    text: string,
  ): PythonValueHandle | null {
    const root = this.rootOf(file);
    if (root === null) {
      return null;
    }
    let found: PyNode | null = null;
    const visit = (node: PyNode): void => {
      if (node.startPosition.row + 1 === line && node.text === text) {
        if (found === null || width(node) <= width(found)) {
          found = node;
        }
      }
      for (const child of namedChildrenOf(node)) {
        visit(child);
      }
    };
    visit(root);
    return found === null ? null : { file: this.pathOf(file), node: found };
  }

  /**
   * The callee of the call written as `calleeText` between `startLine`
   * and `endLine` of `file`, or null.
   */
  findCallee(
    file: string,
    startLine: number,
    endLine: number,
    calleeText: string,
  ): PythonValueHandle | null {
    const root = this.rootOf(file);
    if (root === null) {
      return null;
    }
    let found: PyNode | null = null;
    const visit = (node: PyNode): void => {
      if (node.type === "call") {
        const line = node.startPosition.row + 1;
        const callee = field(node, "function");
        if (
          line >= startLine &&
          line <= endLine &&
          callee !== null &&
          callee.text === calleeText
        ) {
          found = callee;
        }
      }
      for (const child of namedChildrenOf(node)) {
        visit(child);
      }
    };
    visit(root);
    return found === null ? null : { file: this.pathOf(file), node: found };
  }

  /**
   * Why `value` resolves to what it does: the witness proof, flattened
   * to the chain and rendered. Null when the value does not resolve,
   * which the caller says in its own words.
   */
  explain(
    value: PythonValueHandle,
    options: { maxDepth?: number } = {},
  ): WhyExplained | null {
    return explainResolvedKey({
      db: this.db,
      rules: RESOLUTION_RULES,
      key: readKey(value.file, value.node, enclosingFunction(value.node)),
      locate: (key) => this.locate(key),
      displayPath: (key) => this.displayPath(key),
      ...options,
    });
  }

  private locate(key: string): ValueLocation | null {
    const located = this.locations.get(key);
    if (located === undefined) {
      return null;
    }
    return {
      name: displayNameOf(located.node),
      file: this.displayPath(located.file),
      line: located.node.startPosition.row + 1,
    };
  }

  private rootOf(file: string): PyNode | null {
    return this.trees.get(this.pathOf(file)) ?? null;
  }

  private pathOf(file: string): string {
    return path.isAbsolute(file) ? file : path.resolve(this.root, file);
  }

  /** A file path said relative to the root, or as given when it is outside the root. */
  private displayPath(key: string): string {
    if (key.startsWith(this.root)) {
      return path.relative(this.root, key);
    }
    return key;
  }
}
