/**
 * The session behind `suss ask why` on a Ruby project: a tree-sitter
 * parse of the asked-about source, a way to point at the expression
 * somebody spelled, and the witness proof of what it resolved to,
 * rendered through `@suss/resolution`'s phrases.
 *
 * It parses every file under the root and emits the same value and
 * constant facts `extractRubyProject` does, keeping a location for
 * every fact key so a proof's atoms can point back at source. A
 * handle this session hands back pairs a tree-sitter node with the
 * file it came from, since a node alone does not say which file
 * parsed it.
 */

import fs from "node:fs";
import path from "node:path";

import { Database } from "@suss/datalog";
import { explainResolvedKey, RESOLUTION_RULES } from "@suss/resolution";

import { field } from "../ast.js";
import { parseRubySync } from "../parser.js";
import { findRubyFiles } from "../project.js";
import { collectFileConstants, emitConstantBindings } from "./constants.js";
import { RUBY_RULES } from "./resolve.js";
import { emitValueFacts, nodeId, readKey } from "./values.js";

import type { ValueLocation, WhyExplained } from "@suss/resolution";
import type { RbNode } from "../parser.js";
import type { FileConstants } from "./constants.js";

const WITNESS_RULES = [...RESOLUTION_RULES, ...RUBY_RULES];

export interface RubyWhySessionOptions {
  /** The project root, which paths in every answer come out relative to. */
  dir: string;
}

/** A found node, paired with the file it was parsed from. */
export interface RubyValueHandle {
  file: string;
  node: RbNode;
}

interface Located {
  file: string;
  node: RbNode;
}

const METHOD_TYPES = new Set(["method", "singleton_method"]);

function namedChildrenOf(node: RbNode): RbNode[] {
  return node.namedChildren.filter((child): child is RbNode => child !== null);
}

/** The nearest method a node is written inside, or null outside one. */
function enclosingMethod(node: RbNode): RbNode | null {
  let current = node.parent;
  while (current !== null) {
    if (METHOD_TYPES.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Every declaration site in a file: a method or class by its own
 * node, a name it declares by that name's identifier, so a proof atom
 * that is a bare name still says where it came from.
 */
function indexFile(
  file: string,
  root: RbNode,
  locations: Map<string, Located>,
): void {
  const walk = (node: RbNode): void => {
    locations.set(nodeId(file, node), { file, node });

    // A bare constant is name-keyed wherever it is read, not only where
    // it is assigned, so the later occurrence a walk reaches wins.
    if (node.type === "constant") {
      locations.set(`${file}#${node.text}`, { file, node });
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
function displayNameOf(node: RbNode): string {
  if (node.type === "identifier" || node.type === "constant") {
    return node.text;
  }
  if (node.type === "method" || node.type === "singleton_method") {
    return field(node, "name")?.text ?? node.text;
  }
  if (node.type === "class" || node.type === "module") {
    return field(node, "name")?.text ?? node.text;
  }
  const text = node.text.split("\n")[0].trim();
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

function width(node: RbNode): number {
  return node.endIndex - node.startIndex;
}

export class RubyWhySession {
  private readonly root: string;
  private readonly db = new Database();
  private readonly locations = new Map<string, Located>();
  private readonly trees = new Map<string, RbNode>();

  constructor(options: RubyWhySessionOptions) {
    this.root = path.resolve(options.dir);
    const constants: FileConstants[] = [];

    for (const file of findRubyFiles(this.root)) {
      const source = fs.readFileSync(file, "utf8");
      const root = parseRubySync(source).rootNode;
      this.trees.set(file, root);
      emitValueFacts(this.db, file, root);
      constants.push(collectFileConstants(file, root));
      indexFile(file, root, this.locations);
    }
    emitConstantBindings(this.db, constants);
  }

  /**
   * The smallest expression on `line` of `file` whose text is exactly
   * `text`, or null.
   */
  findExpression(
    file: string,
    line: number,
    text: string,
  ): RubyValueHandle | null {
    const root = this.rootOf(file);
    if (root === null) {
      return null;
    }
    let found: RbNode | null = null;
    const visit = (node: RbNode): void => {
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
  ): RubyValueHandle | null {
    const root = this.rootOf(file);
    if (root === null) {
      return null;
    }
    let found: RbNode | null = null;
    const visit = (node: RbNode): void => {
      if (node.type === "call") {
        const line = node.startPosition.row + 1;
        const callee = field(node, "method");
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
    value: RubyValueHandle,
    options: { maxDepth?: number } = {},
  ): WhyExplained | null {
    return explainResolvedKey({
      db: this.db,
      rules: WITNESS_RULES,
      key: readKey(value.file, value.node, enclosingMethod(value.node)),
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

  private rootOf(file: string): RbNode | null {
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
