// rethrow-enrichment.ts — populate rethrow provenance on throw terminals
//
// A bare `throw err` inside a catch block has no constructor, no literal
// message, no static exception type we can resolve at the throw site.
// But its behavioural meaning is the union of exception types the try
// block could raise, which means: the union of throw terminals of every
// function called inside the try.
//
// This pass runs after all summaries are built. For each throw
// transition in each summary, if the throw is a bare-identifier re-throw
// inside a catch block, it walks the enclosing try block's call sites,
// resolves each callee to a summary in the already-extracted set, and
// stamps `transition.metadata.rethrow.possibleSources` with the union
// of exception types and messages those callees could produce.
//
// Scope decisions:
//   * One hop only — callee summaries' throw terminals contribute;
//     transitive throws (A→B→C) would require fixed-point iteration
//     or topological order, deferred until the single-hop version
//     shows its ceiling.
//   * Same-project only — out-of-project callees (node_modules) have
//     no summaries to consult, so their contribution is absent.
//   * Non-breaking — stamps `transition.metadata.rethrow`, never
//     rewrites `output.exceptionType` / `output.message` on the
//     transition itself. Readers opt in to the enrichment by reading
//     metadata; the primary output fields retain their on-the-wire
//     meaning (what the throw statement textually says).

import { Node, type Project } from "ts-morph";

import { createSourceFileLookup } from "./source-file-lookup.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { FunctionRoot } from "./conditions.js";

interface RethrowSource {
  /** Name of the callee inside the try block whose throw we might be propagating. */
  via: string;
  exceptionType: string | null;
  message: string | null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function enrichRethrows(
  summaries: BehavioralSummary[],
  project: Project,
): BehavioralSummary[] {
  // Index summaries by the `file:startLine-endLine` of the function they
  // describe. Callee resolution finds the declaration node; we key its
  // location against this index to look up the matching summary.
  const index = indexSummariesByFunctionLocation(summaries);

  // Build the source-file lookup once. Without this, every summary's
  // locate-by-file path scans the project's full file list — turning
  // the pass into O(summaries × source files) just for the lookup.
  const lookup = createSourceFileLookup(project);

  for (const summary of summaries) {
    // Re-throws live inside catch blocks, which bare-throw an
    // identifier — only summaries with a `throw` transition can
    // host one. Skipping the rest cuts the per-summary locate cost
    // for a 10× majority of summaries that have nothing to enrich.
    if (!summary.transitions.some((t) => t.output.type === "throw")) {
      continue;
    }
    const func = locateFunctionForSummary(summary, lookup);
    if (func === null) {
      continue;
    }
    for (const transition of summary.transitions) {
      if (transition.output.type !== "throw") {
        continue;
      }
      const throwStmt = findBareRethrow(func, transition.location);
      if (throwStmt === null) {
        continue;
      }
      const tryStmt = enclosingTry(throwStmt);
      if (tryStmt === null) {
        continue;
      }
      const sources = collectTryBodyThrowSources(tryStmt, index);
      if (sources.length === 0) {
        continue;
      }
      // Stamp on metadata — additive, non-breaking, doesn't rewrite
      // `output.exceptionType` / `output.message` which stay as the
      // literal throw-site text ("err", null).
      transition.metadata = {
        ...transition.metadata,
        rethrow: { possibleSources: sources },
      };
    }
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Summary indexing
// ---------------------------------------------------------------------------

interface SummaryIndex {
  byFunctionLocation: Map<string, BehavioralSummary>;
}

function locationKey(file: string, start: number, end: number): string {
  return `${file}:${start}-${end}`;
}

function indexSummariesByFunctionLocation(
  summaries: BehavioralSummary[],
): SummaryIndex {
  const byFunctionLocation = new Map<string, BehavioralSummary>();
  for (const s of summaries) {
    const key = locationKey(
      s.location.file,
      s.location.range.start,
      s.location.range.end,
    );
    byFunctionLocation.set(key, s);
  }
  return { byFunctionLocation };
}

// ---------------------------------------------------------------------------
// Locate a summary's FunctionRoot in the project
// ---------------------------------------------------------------------------

function locateFunctionForSummary(
  summary: BehavioralSummary,
  lookup: ReturnType<typeof createSourceFileLookup>,
): FunctionRoot | null {
  const sf = lookup.bySuffix(summary.location.file);
  if (sf === null) {
    return null;
  }
  let found: FunctionRoot | null = null;
  sf.forEachDescendant((node, traversal) => {
    if (found !== null) {
      traversal.stop();
      return;
    }
    if (
      (Node.isFunctionDeclaration(node) ||
        Node.isFunctionExpression(node) ||
        Node.isArrowFunction(node) ||
        Node.isMethodDeclaration(node)) &&
      node.getStartLineNumber() === summary.location.range.start &&
      node.getEndLineNumber() === summary.location.range.end
    ) {
      found = node as FunctionRoot;
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Bare-rethrow detection
// ---------------------------------------------------------------------------

/**
 * Find the `throw <ident>` statement at the transition's location, if
 * that throw's expression is a bare identifier (the re-throw pattern).
 * Returns null for throw statements whose expression is a `new Ctor(...)`
 * or `fn(...)` — those already carried a message through the normal
 * terminal extraction and aren't candidates for rethrow enrichment.
 */
function findBareRethrow(
  func: FunctionRoot,
  location: { start: number; end: number },
): Node | null {
  let found: Node | null = null;
  func.forEachDescendant((node, traversal) => {
    if (found !== null) {
      traversal.stop();
      return;
    }
    if (!Node.isThrowStatement(node)) {
      return;
    }
    if (node.getStartLineNumber() !== location.start) {
      return;
    }
    if (node.getEndLineNumber() !== location.end) {
      return;
    }
    const thrown = node.getExpression();
    if (thrown !== undefined && Node.isIdentifier(thrown)) {
      found = node;
    }
  });
  return found;
}

/**
 * Walk up from a throw statement to find the enclosing try-catch
 * where this throw lives inside the *catch* block. Re-throws at the
 * top of a function or inside the try block itself aren't the pattern
 * we're enriching.
 */
function enclosingTry(throwStmt: Node): Node | null {
  let current: Node | undefined = throwStmt.getParent();
  let sawCatchClause = false;
  while (current !== undefined) {
    if (Node.isCatchClause(current)) {
      sawCatchClause = true;
    }
    if (Node.isTryStatement(current)) {
      return sawCatchClause ? current : null;
    }
    // If we hit a function boundary before a try, the rethrow isn't
    // inside a catch of an enclosing try — bail.
    if (
      Node.isFunctionDeclaration(current) ||
      Node.isFunctionExpression(current) ||
      Node.isArrowFunction(current) ||
      Node.isMethodDeclaration(current)
    ) {
      return null;
    }
    current = current.getParent();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Try-body traversal and callee → summary resolution
// ---------------------------------------------------------------------------

function collectTryBodyThrowSources(
  tryStmt: Node,
  index: SummaryIndex,
): RethrowSource[] {
  if (!Node.isTryStatement(tryStmt)) {
    return [];
  }
  const tryBlock = tryStmt.getTryBlock();
  const sources: RethrowSource[] = [];
  const seen = new Set<string>();

  tryBlock.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const calleeSummary = resolveCalleeSummary(node, index);
    if (calleeSummary === null) {
      return;
    }
    for (const transition of calleeSummary.transitions) {
      if (transition.output.type !== "throw") {
        continue;
      }
      const dedupKey = `${calleeSummary.identity.name}|${transition.output.exceptionType}|${transition.output.message}`;
      if (seen.has(dedupKey)) {
        continue;
      }
      seen.add(dedupKey);
      sources.push({
        via: calleeSummary.identity.name,
        exceptionType: transition.output.exceptionType,
        message: transition.output.message,
      });
    }
  });

  return sources;
}

function resolveCalleeSummary(
  call: Node,
  index: SummaryIndex,
): BehavioralSummary | null {
  if (!Node.isCallExpression(call)) {
    return null;
  }
  const callee = call.getExpression();
  const symbol = callee.getSymbol();
  if (symbol === undefined) {
    return null;
  }
  for (const decl of symbol.getDeclarations()) {
    const func = functionFromDecl(decl);
    if (func === null) {
      continue;
    }
    const sf = func.getSourceFile();
    // The index is keyed by the summary's relative file path; keys in
    // it may or may not match absolute paths. Try both.
    const absPath = sf.getFilePath();
    const start = func.getStartLineNumber();
    const end = func.getEndLineNumber();
    // Summary paths are relative to the project root after CLI processing,
    // or absolute in-process. Match by suffix against either.
    for (const [key, summary] of index.byFunctionLocation) {
      if (
        key.endsWith(`:${start}-${end}`) &&
        (absPath.endsWith(summary.location.file) ||
          summary.location.file.endsWith(absPath))
      ) {
        return summary;
      }
    }
  }
  return null;
}

function functionFromDecl(decl: Node): FunctionRoot | null {
  if (
    Node.isFunctionDeclaration(decl) ||
    Node.isFunctionExpression(decl) ||
    Node.isArrowFunction(decl) ||
    Node.isMethodDeclaration(decl)
  ) {
    return decl as FunctionRoot;
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (
      init !== undefined &&
      (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
    ) {
      return init as FunctionRoot;
    }
  }
  return null;
}
