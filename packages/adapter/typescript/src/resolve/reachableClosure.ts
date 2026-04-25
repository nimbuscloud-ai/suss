// reachableClosure.ts — transitive-closure library discovery
//
// After pack-based discovery produces summaries for handlers, components,
// resolvers, and consumers, this pass walks the call graph from those
// summaries into the rest of the user's code. Every function reachable
// through a static CallExpression chain becomes a `library`-kind summary
// with `boundaryBinding.recognition = "reachable"`, so readers can see
// the behaviour of internal orchestrators and helpers without the pack
// author having to enumerate them.
//
// Scope:
//   * Same-project only — declarations in node_modules or `.d.ts` files
//     are skipped. Package boundaries go through `packageExports` /
//     `packageImport`, not this pass.
//   * Direct CallExpressions only — higher-order indirection (`fns.map(f)`
//     where `f` is a parameter, dispatch-table lookups) isn't resolved.
//   * Function-shaped declarations — FunctionDeclaration, ArrowFunction,
//     FunctionExpression, MethodDeclaration (as a module-level export).
//   * One summary per function node — dedup against pack-produced
//     summaries to avoid double-coverage.

import { Node, type Project, type SourceFile } from "ts-morph";

import { functionCallBinding } from "@suss/behavioral-ir";
import { assembleSummary, type ExtractorOptions } from "@suss/extractor";

import { extractCodeStructure } from "../adapter.js";
import { lazyAddSourceFile } from "../bootstrap/lazyProjectInit.js";
import { createSourceFileLookup } from "../bootstrap/sourceFileLookup.js";
import { type DiscoveredUnit, toFunctionRoot } from "../discovery/index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";

// ---------------------------------------------------------------------------
// The "reachable" pack — terminals and input mapping for library functions
// ---------------------------------------------------------------------------

const reachablePack: PatternPack = {
  name: "reachable",
  languages: ["typescript"],
  protocol: "in-process",
  discovery: [],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
    {
      // Implicit fall-through at the end of a function body — covers
      // void-returning orchestrators that never write `return`.
      kind: "return",
      match: { type: "functionFallthrough" },
      extraction: {},
    },
  ],
  inputMapping: { type: "allPositional" },
};

// ---------------------------------------------------------------------------
// Function-node identity
// ---------------------------------------------------------------------------

function nodeKey(func: FunctionRoot): string {
  const sf = func.getSourceFile();
  return `${sf.getFilePath()}:${func.getStart()}-${func.getEnd()}`;
}

// ---------------------------------------------------------------------------
// Locate a summary's FunctionRoot in the project
// ---------------------------------------------------------------------------

function locateFunctionBySummary(
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
// Callee resolution
// ---------------------------------------------------------------------------

/**
 * A function-shaped declaration we can follow into. Records the source
 * node (for dedup + extraction) and a display name (for `summary.identity.name`).
 */
interface ReachableCandidate {
  func: FunctionRoot;
  name: string;
}

function isInExternalCode(sourceFile: SourceFile): boolean {
  if (sourceFile.isDeclarationFile()) {
    return true;
  }
  const filePath = sourceFile.getFilePath();
  // ts-morph surfaces files from node_modules when they're transitively
  // imported; skip them — the package-exports / package-import packs
  // handle library boundaries separately.
  if (filePath.includes("/node_modules/")) {
    return true;
  }
  return false;
}

/**
 * Follow a declaration node to an underlying function-shaped declaration
 * we can extract from. Returns null for declarations that don't resolve
 * (namespaces, classes without a called method, external-module imports,
 * parameters, etc.) — the closure skips those.
 */
function hasBody(fn: FunctionRoot): boolean {
  // FunctionDeclaration / MethodDeclaration can be ambient (`declare
  // function foo()`) or overload signatures; both lack a body node.
  // Arrow + function expressions always have an associated body. We
  // don't want to follow into ambient declarations — they're type-
  // only and have no behaviour to summarize.
  if (
    Node.isFunctionDeclaration(fn) ||
    Node.isMethodDeclaration(fn) ||
    Node.isFunctionExpression(fn)
  ) {
    const body = fn.getBody?.();
    return body !== undefined;
  }
  return true;
}

function resolveDecl(
  decl: Node,
  calleeName: string,
): ReachableCandidate | null {
  if (isInExternalCode(decl.getSourceFile())) {
    return null;
  }
  const fn = toFunctionRoot(decl);
  if (fn !== null) {
    if (!hasBody(fn)) {
      return null;
    }
    return { func: fn, name: declName(decl) ?? calleeName };
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (
      init !== undefined &&
      (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
    ) {
      return { func: init as FunctionRoot, name: decl.getName() };
    }
    return null;
  }
  if (Node.isImportSpecifier(decl)) {
    const importDecl = decl.getImportDeclaration();
    const sf = importDecl.getModuleSpecifierSourceFile();
    if (sf === undefined || isInExternalCode(sf)) {
      return null;
    }
    const exported = sf.getExportedDeclarations().get(decl.getName());
    if (exported === undefined) {
      return null;
    }
    for (const ed of exported) {
      const resolved = resolveDecl(ed, calleeName);
      if (resolved !== null) {
        return resolved;
      }
    }
    return null;
  }
  return null;
}

/**
 * Best-effort name extraction for a reached declaration — used for
 * `summary.identity.name`. FunctionDeclaration / MethodDeclaration have
 * a direct name. Arrow/function expressions bound to a variable borrow
 * the variable name.
 */
function declName(decl: Node): string | null {
  if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
    const n = decl.getName?.();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }
  if (Node.isFunctionExpression(decl)) {
    const n = decl.getName();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }
  const parent = decl.getParent();
  if (parent !== undefined && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  return null;
}

function resolveCallee(
  call: Node,
  calleeName: string,
): ReachableCandidate | null {
  if (!Node.isCallExpression(call)) {
    return null;
  }
  const callee = call.getExpression();
  const symbol = callee.getSymbol();
  if (symbol === undefined) {
    return null;
  }
  for (const decl of symbol.getDeclarations()) {
    const resolved = resolveDecl(decl, calleeName);
    if (resolved !== null) {
      return resolved;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Walk all CallExpressions in a function body (including nested callbacks)
// ---------------------------------------------------------------------------
//
// Unlike `extractInvocationEffects` — which skips nested functions because
// their calls belong to their own summaries — reachability follows every
// CallExpression regardless of nesting. Callbacks passed to higher-order
// functions (`bluebird.map(rs, async r => helper(r))`) would otherwise
// leave `helper` unreachable because no pack matches the callback itself.
// Dedup by function-node key keeps us from double-summarising a helper
// that's also reached directly.

function collectReachable(func: FunctionRoot): ReachableCandidate[] {
  const found: ReachableCandidate[] = [];
  const seen = new Set<string>();

  func.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const calleeText = node.getExpression().getText();
    const resolved = resolveCallee(node, calleeText);
    if (resolved === null) {
      return;
    }
    const key = nodeKey(resolved.func);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    found.push(resolved);
  });

  return found;
}

// ---------------------------------------------------------------------------
// Build a library summary from a reached function
// ---------------------------------------------------------------------------

function extractReachableSummary(
  candidate: ReachableCandidate,
  options: ExtractorOptions | undefined,
): BehavioralSummary {
  const unit: DiscoveredUnit = {
    func: candidate.func,
    kind: "library",
    name: candidate.name,
  };
  const raw = extractCodeStructure(
    unit,
    reachablePack,
    candidate.func.getSourceFile().getFilePath(),
  );
  raw.boundaryBinding = functionCallBinding({
    transport: "in-process",
    recognition: "reachable",
  });
  return assembleSummary(raw, options);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Expand the seed summaries into a superset that includes every
 * library function transitively reachable through static call edges.
 * Returns `seeds` concatenated with the new library summaries. Seeds
 * already in the set (either by pack discovery or by earlier closure
 * iterations) are never re-emitted.
 */
export function expandReachableClosure(
  seeds: BehavioralSummary[],
  project: Project,
  options?: ExtractorOptions,
  projectFileSet?: ReadonlySet<string>,
): BehavioralSummary[] {
  const covered = new Set<string>();
  const worklist: FunctionRoot[] = [];

  // One source-file enumeration shared across every seed locate.
  // Without this, each `locateFunctionBySummary` was re-scanning the
  // project's full file list — N seeds × M source files of redundant
  // walk work.
  const lookup = createSourceFileLookup(project);

  // Seed the covered set with every already-summarized function so the
  // closure doesn't re-emit pack units as library duplicates.
  for (const seed of seeds) {
    const func = locateFunctionBySummary(seed, lookup);
    if (func !== null) {
      covered.add(nodeKey(func));
      worklist.push(func);
    }
  }

  const reached: BehavioralSummary[] = [];
  while (worklist.length > 0) {
    const func = worklist.shift();
    if (func === undefined) {
      break;
    }
    for (const candidate of collectReachable(func)) {
      const key = nodeKey(candidate.func);
      if (covered.has(key)) {
        continue;
      }
      covered.add(key);
      // Lazy-add: ts-morph's symbol resolution loaded the candidate's
      // source file into the underlying program but didn't register it
      // with the project's source-file tracker. Without an explicit
      // add, downstream passes (rethrow enrichment, partial-hit
      // closure dedup) can't find the file via project.getSourceFiles().
      // Guarded by projectFileSet so we never pollute the project with
      // paths outside the tsconfig include.
      if (projectFileSet !== undefined) {
        lazyAddSourceFile(
          project,
          projectFileSet,
          candidate.func.getSourceFile().getFilePath(),
        );
      }
      reached.push(extractReachableSummary(candidate, options));
      worklist.push(candidate.func);
    }
  }

  return [...seeds, ...reached];
}
