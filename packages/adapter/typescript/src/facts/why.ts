/**
 * The session behind `suss ask why`: a ts-morph project over the
 * asked-about source, a way to point at the expression somebody
 * spelled, and the witness proof of what it resolved to, rendered
 * through `@suss/resolution`'s phrases.
 *
 * The CLI points at values with a file, a line, and the text as
 * written, because that is what a person has in hand. Everything
 * ts-morph stays behind this class; callers treat the found nodes as
 * opaque handles to pass back in.
 */

import path from "node:path";

import { Node, Project, SyntaxKind } from "ts-morph";

import { explainResolutionProof, renderExplanation } from "@suss/resolution";

import {
  createProjectWithoutTsconfig,
  findNearestTsconfig,
} from "../bootstrap/noTsconfigProject.js";
import { ResolutionStore } from "./store.js";

import type { StepPhrase, ValueLocation, WhyExplained } from "@suss/resolution";
import type { SourceFile } from "ts-morph";

/** The phrase for the one step rule this adapter adds to the shared ones. */
const JS_PHRASES: Record<string, StepPhrase> = {
  bind: ({ tuple, describe }) => ({
    reason: `${describe(tuple[0])} is a .bind of ${describe(tuple[1])}, which runs the same function`,
  }),
};

export interface WhySessionOptions {
  /** The project root, which paths in every answer come out relative to. */
  dir: string;
}

export class TypeScriptWhySession {
  private readonly project: Project;
  private readonly store: ResolutionStore;
  private readonly root: string;

  constructor(options: WhySessionOptions) {
    this.root = path.resolve(options.dir);
    const tsconfig = findNearestTsconfig(this.root);
    this.project =
      tsconfig === null
        ? createProjectWithoutTsconfig(this.root).project
        : new Project({ tsConfigFilePath: tsconfig });
    this.store = new ResolutionStore();
  }

  /**
   * The smallest expression on `line` of `file` whose text is exactly
   * `text`, or null. Spelled from the person's side: the name as
   * written, not a node id.
   */
  findExpression(file: string, line: number, text: string): Node | null {
    const sourceFile = this.sourceFileAt(file);
    if (sourceFile === null) {
      return null;
    }
    let found: Node | null = null;
    sourceFile.forEachDescendant((node) => {
      if (
        Node.isExpression(node) &&
        node.getStartLineNumber() === line &&
        node.getText() === text &&
        (found === null || node.getWidth() <= found.getWidth())
      ) {
        found = node;
      }
    });
    return found;
  }

  /**
   * The callee of the call written as `calleeText` between `startLine`
   * and `endLine` of `file`, or null. This is how a summary's recorded
   * callee gets back to its node: the summary keeps source text and a
   * range, not ids.
   */
  findCallee(
    file: string,
    startLine: number,
    endLine: number,
    calleeText: string,
  ): Node | null {
    const sourceFile = this.sourceFileAt(file);
    if (sourceFile === null) {
      return null;
    }
    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      const line = call.getStartLineNumber();
      if (line < startLine || line > endLine) {
        continue;
      }
      if (call.getExpression().getText() === calleeText) {
        return call.getExpression();
      }
    }
    return null;
  }

  /**
   * Why `value` resolves to what it does: the witness proof, flattened
   * to the chain and rendered. Null when the value does not resolve,
   * which the caller says in its own words.
   */
  explain(
    value: Node,
    options: { maxDepth?: number } = {},
  ): WhyExplained | null {
    const explained = this.store.explainCallable(value, options);
    if (explained === null) {
      return null;
    }
    const describe = (atom: string | number): string => {
      const node = explained.nodeFor(atom);
      if (node === undefined) {
        return this.displayPath(String(atom));
      }
      const at = this.locate(node);
      return `${at.name} (${at.file}:${at.line})`;
    };
    const explanation = explainResolutionProof(explained.proof, {
      describe,
      phrases: JS_PHRASES,
    });
    if (explanation === null) {
      return null;
    }
    return {
      explanation,
      chain: explanation.atoms.map((atom) => describe(atom)),
      lines: renderExplanation(explanation, describe),
      target: this.locate(explained.target),
      stats: explained.stats,
    };
  }

  /** Where a found node is, in the terms an answer prints. */
  locate(node: Node): ValueLocation {
    return {
      name: displayNameOf(node),
      file: this.displayPath(node.getSourceFile().getFilePath()),
      line: node.getStartLineNumber(),
    };
  }

  private sourceFileAt(file: string): SourceFile | null {
    const absolute = path.resolve(this.root, file);
    const loaded = this.project.getSourceFile(absolute);
    if (loaded !== undefined) {
      return loaded;
    }
    try {
      return this.project.addSourceFileAtPath(absolute);
    } catch {
      return null;
    }
  }

  /** A module key: a file path said relative to the root, or a package name. */
  private displayPath(key: string): string {
    if (key.startsWith(this.root)) {
      return path.relative(this.root, key);
    }
    return key;
  }
}

/** What to call a node in a sentence. */
function displayNameOf(node: Node): string {
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
    return node.getText();
  }
  if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
    return `${node.getExpression()?.getText() ?? "call"}(...)`;
  }
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isVariableDeclaration(node)
  ) {
    const name = node.getName();
    if (name !== undefined) {
      return name;
    }
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const parent = node.getParent();
    if (parent !== undefined && Node.isVariableDeclaration(parent)) {
      return parent.getName();
    }
  }
  const text = node.getText().split("\n")[0].trim();
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}
