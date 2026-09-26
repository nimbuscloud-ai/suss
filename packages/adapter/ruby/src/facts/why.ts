/**
 * The session behind `suss ask why` on a Ruby project. It parses every
 * file under the root with tree-sitter, finds the expression a question
 * points at, and renders the witness proof of what that expression
 * resolved to through `@suss/resolution`'s phrases.
 *
 * It emits its facts through the same `RunFacts` an extraction over the
 * same packs uses, and keeps a location for every fact key so each atom
 * of a proof can point back at source. A handle pairs a tree-sitter node
 * with its file, since a node alone does not say which file it came from.
 */

import fs from "node:fs";
import path from "node:path";

import { Database } from "@suss/datalog";
import { explainResolvedKey, RESOLUTION_RULES } from "@suss/resolution";

import { enclosingDefinition, field } from "../ast.js";
import { parseRubySync } from "../parser.js";
import { findRubyFiles, RunFacts } from "../project.js";
import { parametersOf, paramNameOf } from "./locals.js";
import { RUBY_RULES } from "./resolve.js";
import { calleeKeyOf, nodeId, readKey } from "./values.js";

import type { ValueLocation, WhyExplained } from "@suss/resolution";
import type { RubyPack } from "../pack.js";
import type { RbNode } from "../parser.js";

const WITNESS_RULES = [...RESOLUTION_RULES, ...RUBY_RULES];

export interface RubyWhySessionOptions {
  /** The project root. Paths in every answer are relative to it. */
  dir: string;
  /** The packs the extraction ran with. A hop only a pack declares, such as `Account.find` giving back an Account, is explained only when that pack is here. */
  packs?: readonly RubyPack[];
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

function namedChildrenOf(node: RbNode): RbNode[] {
  return node.namedChildren.filter((child): child is RbNode => child !== null);
}

/** The statements that write a local, `x = ...` and `x ||= ...`. */
const ASSIGNMENT_TYPES = new Set(["assignment", "operator_assignment"]);

/** The definitions and blocks whose parameters are locals of the body they open. */
const PARAMETER_OWNER_TYPES = new Set([
  "method",
  "singleton_method",
  "lambda",
  "block",
  "do_block",
]);

/**
 * Indexes every node in a file by its key. A constant, an assigned local
 * and a parameter are also indexed by their name key, so a proof atom
 * that is a bare name still points at source. A local is keyed on the
 * method or block it belongs to, the same way the facts key it.
 */
function indexFile(
  file: string,
  root: RbNode,
  locations: Map<string, Located>,
): void {
  const writesName = (name: RbNode): void => {
    locations.set(readKey(file, name, enclosingDefinition(name)), {
      file,
      node: name,
    });
  };
  const walk = (node: RbNode): void => {
    locations.set(nodeId(file, node), { file, node });

    // A bare constant gets a name key wherever it appears, so the last
    // occurrence the walk reaches wins.
    if (node.type === "constant") {
      locations.set(`${file}#${node.text}`, { file, node });
    }
    if (ASSIGNMENT_TYPES.has(node.type)) {
      const left = field(node, "left");
      if (left !== null && left.type === "identifier") {
        writesName(left);
      }
    }
    if (PARAMETER_OWNER_TYPES.has(node.type)) {
      for (const parameter of parametersOf(node)) {
        const name = paramNameOf(parameter);
        if (name !== null) {
          writesName(name);
        }
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

/**
 * The key to ask about for this expression. For a call it is the
 * callee's key, since a question about a call is about which method runs.
 */
function askedKey(value: RubyValueHandle): string {
  const enclosing = enclosingDefinition(value.node);
  return (
    calleeKeyOf(value.file, value.node, enclosing) ??
    readKey(value.file, value.node, enclosing)
  );
}

export class RubyWhySession {
  private readonly root: string;
  private readonly db = new Database();
  private readonly locations = new Map<string, Located>();
  private readonly trees = new Map<string, RbNode>();

  constructor(options: RubyWhySessionOptions) {
    this.root = path.resolve(options.dir);
    const facts = new RunFacts(this.db, options.packs ?? []);

    for (const file of findRubyFiles(this.root)) {
      const source = fs.readFileSync(file, "utf8");
      const root = parseRubySync(source).rootNode;
      this.trees.set(file, root);
      facts.addFile(file, root);
      indexFile(file, root, this.locations);
    }
    facts.finish();
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
   * to the chain and rendered. Null when the value does not resolve, and
   * the caller reports that itself.
   */
  explain(
    value: RubyValueHandle,
    options: { maxDepth?: number } = {},
  ): WhyExplained | null {
    return explainResolvedKey({
      db: this.db,
      rules: WITNESS_RULES,
      key: askedKey(value),
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

  /** A file path relative to the root, or unchanged when it is outside the root. */
  private displayPath(key: string): string {
    if (key.startsWith(this.root)) {
      return path.relative(this.root, key);
    }
    return key;
  }
}
