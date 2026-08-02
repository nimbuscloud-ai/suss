// rethrowEnrichment.ts — populate rethrow provenance on throw terminals
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
//   * Transitive through rethrow chains — `A → B → C` where each hop
//     re-throws resolves C's throw terminals all the way up to A. The
//     fixpoint runs as datalog rules over facts built from the summary
//     set: `contributes(u, s)` holds for a unit's own throw terminals
//     and, recursively, for whatever the callees inside its rethrow's
//     try block contribute. Propagation through *plain* calls (an
//     uncaught exception crossing a frame with no try at all) is the
//     full may-throw analysis and stays a follow-up.
//   * Same-project only — out-of-project callees (node_modules) have
//     no summaries to consult, so their contribution is absent.
//   * Non-breaking — stamps `transition.metadata.rethrow`, never
//     rewrites `output.exceptionType` / `output.message` on the
//     transition itself. Readers opt in to the enrichment by reading
//     metadata; the primary output fields retain their on-the-wire
//     meaning (what the throw statement textually says).

import { Node, type Project } from "ts-morph";

import { Database, evaluate, lit, rule, variable } from "@suss/datalog";

import { createSourceFileLookup } from "../bootstrap/sourceFileLookup.js";
import { endLineOf, startLineOf } from "../lines.js";

import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";
import type { FunctionRoot } from "../conditions.js";
import type { ClosureFacts } from "./boundaryEffects.js";

interface RethrowSource {
  /** Name of the callee inside the try block whose throw we might be propagating. */
  via: string;
  exceptionType: string | null;
  message: string | null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// The propagation semantics, as rules: a unit contributes what its own
// throw terminals say (exactly the old one-hop contract), and — the
// transitive step — whatever the callees inside one of its rethrow
// sites' try blocks contribute.
const RETHROW_RULES = [
  rule(
    "contributes",
    [variable("u"), variable("s")],
    [lit("throwsDirect", variable("u"), variable("s"))],
  ),
  rule(
    "contributes",
    [variable("u"), variable("s")],
    [
      lit("rethrowSite", variable("u"), variable("site")),
      lit("siteCalls", variable("site"), variable("c")),
      lit("contributes", variable("c"), variable("s")),
    ],
  ),
];

interface RethrowTarget {
  transition: Transition;
  siteId: string;
}

export function enrichRethrows(
  summaries: BehavioralSummary[],
  project: Project,
  facts?: ClosureFacts,
): BehavioralSummary[] {
  // Index summaries by the `file:startLine-endLine` of the function they
  // describe. Callee resolution finds the declaration node; we key its
  // location against this index to look up the matching summary.
  const index = indexSummariesByFunctionLocation(summaries);

  // Build the source-file lookup once. Without this, every summary's
  // locate-by-file path scans the project's full file list — turning
  // the pass into O(summaries × source files) just for the lookup.
  const lookup = createSourceFileLookup(project);

  // Unit naming: prefer the shared store's offset-based keys, so the
  // relations this pass emits (`throwsDirect`, `contributes`, …) join
  // against `entry` / `calls` / `unitEffect` under one identity.
  // Summaries the closure never registered (or runs without the
  // closure at all) fall back to the line-based key — every mint goes
  // through here, so this pass stays internally consistent either way.
  const keyFor = (summary: BehavioralSummary): string =>
    facts?.unitKeyBySummary.get(summary) ??
    locationKey(
      summary.location.file,
      summary.location.range.start,
      summary.location.range.end,
    );

  // ---- Fact emission ------------------------------------------------
  const db = facts?.db ?? new Database();
  const sourceById = new Map<
    string,
    { exceptionType: string | null; message: string | null }
  >();
  const nameByUnit = new Map<string, string>();
  const targets: RethrowTarget[] = [];
  let siteCounter = 0;

  for (const summary of summaries) {
    // Re-throws live inside catch blocks, which bare-throw an
    // identifier — only summaries with a `throw` transition can host
    // one or contribute sources. Skipping the rest cuts the per-summary
    // locate cost for a 10× majority with nothing to say.
    if (!summary.transitions.some((t) => t.output.type === "throw")) {
      continue;
    }
    const unitKey = keyFor(summary);
    nameByUnit.set(unitKey, summary.identity.name);

    // Every throw terminal contributes what it textually says. Bare
    // re-throws contribute their (null-ish) site facts too — keeping
    // the derived source set a strict superset of the old one-hop
    // results — and additionally expand through their try block below.
    for (const transition of summary.transitions) {
      if (transition.output.type !== "throw") {
        continue;
      }
      const sourceId = JSON.stringify([
        transition.output.exceptionType,
        transition.output.message,
      ]);
      sourceById.set(sourceId, {
        exceptionType: transition.output.exceptionType,
        message: transition.output.message,
      });
      db.add("throwsDirect", [unitKey, sourceId]);
    }

    const func = lookup.functionAt(summary.location);
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
      const siteId = `${unitKey}#${siteCounter}`;
      siteCounter += 1;
      db.add("rethrowSite", [unitKey, siteId]);
      targets.push({ transition, siteId });
      for (const calleeKey of collectTryBodyCallees(tryStmt, index, keyFor)) {
        db.add("siteCalls", [siteId, calleeKey]);
      }
    }
  }

  // ---- Fixpoint -----------------------------------------------------
  evaluate(db, RETHROW_RULES);

  const contributesByUnit = new Map<string, string[]>();
  for (const [unit, sourceId] of db.facts("contributes")) {
    const bucket = contributesByUnit.get(String(unit));
    if (bucket === undefined) {
      contributesByUnit.set(String(unit), [String(sourceId)]);
    } else {
      bucket.push(String(sourceId));
    }
  }

  // ---- Stamp enrichment metadata ------------------------------------
  for (const target of targets) {
    const sources: RethrowSource[] = [];
    const seen = new Set<string>();
    for (const [site, calleeKeyAtom] of db.facts("siteCalls")) {
      if (site !== target.siteId) {
        continue;
      }
      const calleeKey = String(calleeKeyAtom);
      const via = nameByUnit.get(calleeKey) ?? calleeKey;
      for (const sourceId of contributesByUnit.get(calleeKey) ?? []) {
        const source = sourceById.get(sourceId);
        if (source === undefined) {
          continue;
        }
        const dedupKey = `${via}|${source.exceptionType}|${source.message}`;
        if (seen.has(dedupKey)) {
          continue;
        }
        seen.add(dedupKey);
        sources.push({ via, ...source });
      }
    }
    if (sources.length === 0) {
      continue;
    }
    // Stamp on metadata — additive, non-breaking, doesn't rewrite
    // `output.exceptionType` / `output.message` which stay as the
    // literal throw-site text ("err", null).
    target.transition.metadata = {
      ...target.transition.metadata,
      rethrow: { possibleSources: sources },
    };
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
    if (startLineOf(node) !== location.start) {
      return;
    }
    if (endLineOf(node) !== location.end) {
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

/**
 * The callee units invoked inside a try block, as summary-location
 * keys — the `siteCalls` fact set for one rethrow site. The rules
 * expand each callee's transitive contributions from here.
 */
function collectTryBodyCallees(
  tryStmt: Node,
  index: SummaryIndex,
  keyFor: (summary: BehavioralSummary) => string,
): string[] {
  if (!Node.isTryStatement(tryStmt)) {
    return [];
  }
  const tryBlock = tryStmt.getTryBlock();
  const callees: string[] = [];
  const seen = new Set<string>();

  tryBlock.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const calleeSummary = resolveCalleeSummary(node, index);
    if (calleeSummary === null) {
      return;
    }
    const key = keyFor(calleeSummary);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    callees.push(key);
  });

  return callees;
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
    const start = startLineOf(func);
    const end = endLineOf(func);
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
