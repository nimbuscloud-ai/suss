// callAccounting.ts: classify every call the invocation walk visits
// against the terminal shapes every function has, with no pack in front
// of the source.

import { SyntaxKind } from "ts-morph";

import {
  extractRawBranches,
  GENERIC_TERMINALS,
  hasBody,
  NO_BARRIERS,
  startsItsOwnScope,
} from "@suss/adapter-typescript";

import type {
  CallAccountingOutcome,
  FunctionRoot,
} from "@suss/adapter-typescript";
import type { SourceFile } from "ts-morph";

/** One call the walk visited, resolved to where a person would look. */
export interface CallAccountingResult {
  readonly file: string;
  readonly line: number;
  readonly callee: string;
  readonly outcome: CallAccountingOutcome;
}

/**
 * Every function-shaped root the invocation walk treats as its own
 * unit: a named function or method, and an arrow or function expression
 * with no function of its own around it. A nested arrow is read only
 * through its enclosing root, since that root's own descent reaches it.
 */
function unitRootsIn(sourceFile: SourceFile): FunctionRoot[] {
  const named = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
  ].filter((fn) => hasBody(fn));

  const detached = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ].filter((fn) => fn.getFirstAncestor(startsItsOwnScope) === undefined);

  return [...named, ...detached];
}

/** Every call the invocation walk visits across every unit root in `sourceFile`. */
export function accountForFile(sourceFile: SourceFile): CallAccountingResult[] {
  const file = sourceFile.getFilePath();
  const results: CallAccountingResult[] = [];

  for (const root of unitRootsIn(sourceFile)) {
    const { callAccounting } = extractRawBranches(
      root,
      GENERIC_TERMINALS,
      [],
      [],
      NO_BARRIERS,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    for (const entry of callAccounting ?? []) {
      results.push({
        file,
        line: entry.line,
        callee: entry.callee,
        outcome: entry.outcome,
      });
    }
  }

  return results;
}

/** The same, over every source file in a project. */
export function accountForProject(
  sourceFiles: readonly SourceFile[],
): CallAccountingResult[] {
  return sourceFiles.flatMap((sourceFile) => accountForFile(sourceFile));
}

/** Where a result points, for an exemption list and a failure message. */
export function keyOf(result: CallAccountingResult): string {
  return `${result.file}:${result.line}:${result.callee}`;
}

/**
 * Every result the walk dropped: reached, but neither recorded nor
 * matched as a terminal, and not one of `exempt`'s known cases.
 */
export function unaccountedCalls(
  results: readonly CallAccountingResult[],
  exempt: ReadonlySet<string> = new Set(),
): CallAccountingResult[] {
  return results.filter(
    (result) => result.outcome === "unrecorded" && !exempt.has(keyOf(result)),
  );
}

/** One line per dropped call, for a failing assertion's message. */
export function describeDrops(
  dropped: readonly CallAccountingResult[],
): string {
  return dropped.map((result) => keyOf(result)).join("\n");
}
