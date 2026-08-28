// reachableClosure.ts: transitive-closure library discovery
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
//   * Same-project only: declarations in node_modules or `.d.ts` files
//     are skipped. Package boundaries go through `packageExports` /
//     `packageImport`, not this pass.
//   * Direct CallExpressions only: higher-order indirection (`fns.map(f)`
//     where `f` is a parameter, dispatch-table lookups) isn't resolved.
//   * A call landing on an interface the project declares goes into the
//     class the construction site passed, or the one a factory built.
//   * Function-shaped declarations: FunctionDeclaration, ArrowFunction,
//     FunctionExpression, MethodDeclaration (as a module-level export).
//   * One summary per function node: dedup against pack-produced
//     summaries to avoid double-coverage.

import { Node, type Project, type SourceFile } from "ts-morph";

import { functionCallBinding } from "@suss/behavioral-ir";
import { Database, evaluate, lit, rule, variable } from "@suss/datalog";
import { assembleSummary, type ExtractorOptions } from "@suss/extractor";

import { extractCodeStructure } from "../adapter.js";
import { lazyAddSourceFile } from "../bootstrap/lazyProjectInit.js";
import { createSourceFileLookup } from "../bootstrap/sourceFileLookup.js";
import { createDependencySink, withDependencySink } from "../depTracking.js";
import { offsetKeyOf } from "../walk/nodeKeys.js";
import { type ReachableCandidate, resolveDecl } from "./functionBehind.js";
import {
  classifyStop,
  declarationsBehind,
  hasBody,
  isDeclaredShape,
  type UnfollowedCall,
  unfollowedCallGap,
  worthRecording,
} from "./unfollowedCall.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type {
  AccessRecognizer,
  InvocationRecognizer,
  PatternPack,
} from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { DiscoveredUnit } from "../discovery/index.js";
import type { ClosureFacts } from "./boundaryEffects.js";

// ---------------------------------------------------------------------------
// The "reachable" pack: terminals and input mapping for library functions
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
      // Implicit fall-through at the end of a function body: covers
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
  return offsetKeyOf(func);
}

// ---------------------------------------------------------------------------
// Callee resolution
// ---------------------------------------------------------------------------

/**
 * A function-shaped declaration we can follow into. Records the source
 * node (for dedup + extraction) and a display name (for `summary.identity.name`).
 */

/**
 * What one call site came to: a function to walk into, or a stop the
 * closure describes rather than drops.
 */
type CallOutcome =
  | { readonly kind: "followed"; readonly candidate: ReachableCandidate }
  | { readonly kind: "stopped"; readonly stop: UnfollowedCall };

function resolveCallee(
  call: Node,
  calleeName: string,
  scan: ScanContext,
): CallOutcome | null {
  if (!Node.isCallExpression(call)) {
    return null;
  }
  const callee = call.getExpression();
  const symbol = callee.getSymbol();
  // The same declarations the stop classifier reads, so a call the
  // walk refuses and a call it describes as unfollowed are the same
  // call. An imported name's own declaration says only that something
  // was imported.
  const declarations = declarationsBehind(symbol);
  for (const decl of declarations) {
    const resolved = resolveDecl(decl, calleeName);
    if (resolved !== null) {
      return { kind: "followed", candidate: resolved };
    }
  }

  // A call landing on an interface the project declares has no body to
  // walk into: the field was handed a class, or a factory built one.
  // Resolution says which, for the price of a module-graph walk.
  const resolveSources = scan.resolveCallableSources;
  if (
    resolveSources !== undefined &&
    Node.isPropertyAccessExpression(callee) &&
    declarations.some(isDeclaredShape)
  ) {
    const sources = resolveSources(callee, scan.reachedFrom);
    const only = sources.length === 1 ? sources[0] : undefined;
    const resolved = only === undefined ? null : resolveDecl(only, calleeName);
    if (resolved !== null) {
      return { kind: "followed", candidate: resolved };
    }
    if (sources.length > 1) {
      return {
        kind: "stopped",
        stop: { callee: calleeName, reason: "multipleSources" },
      };
    }
  }

  return {
    kind: "stopped",
    stop: {
      callee: calleeName,
      reason: classifyStop(declarationsBehind(symbol)),
    },
  };
}

// ---------------------------------------------------------------------------
// Walk all CallExpressions in a function body (including nested callbacks)
// ---------------------------------------------------------------------------
//
// Unlike `extractInvocationEffects`: which skips nested functions because
// their calls belong to their own summaries: reachability follows every
// CallExpression regardless of nesting. Callbacks passed to higher-order
// functions (`bluebird.map(rs, async r => helper(r))`) would otherwise
// leave `helper` unreachable because no pack matches the callback itself.
// Dedup by function-node key keeps us from double-summarising a helper
// that's also reached directly.

/**
 * What one pass over a function's body has to hand. `reachedFrom` is
 * the file of whoever called this function, which is where a dependency
 * it was handed was constructed.
 */
interface ScanContext {
  resolveCallableSources?: (value: Node, alsoFrom?: SourceFile) => Node[];
  reachedFrom?: SourceFile;
}

/** Everything one pass over a body found: edges to walk, and stops. */
interface ScanResult {
  readonly candidates: ReachableCandidate[];
  readonly stops: UnfollowedCall[];
}

/**
 * A JSX reference is a render-time call: `<UserCard/>` runs `UserCard`
 * the way `userCard()` would, so the closure follows it. Host tags are
 * lowercase and member tags (`<Foo.Bar/>`) wait on richer resolution.
 */
function resolveJsxReference(
  node: Node,
): { tag: string; outcome: CallOutcome } | null {
  if (!Node.isJsxOpeningElement(node) && !Node.isJsxSelfClosingElement(node)) {
    return null;
  }
  const tag = node.getTagNameNode();
  if (!Node.isIdentifier(tag) || !/^[A-Z]/.test(tag.getText())) {
    return null;
  }
  const name = tag.getText();
  const declarations = declarationsBehind(tag.getSymbol());
  for (const decl of declarations) {
    const resolved = resolveDecl(decl, name);
    if (resolved !== null) {
      return { tag: name, outcome: { kind: "followed", candidate: resolved } };
    }
  }
  return {
    tag: name,
    outcome: {
      kind: "stopped",
      stop: { callee: name, reason: classifyStop(declarations) },
    },
  };
}

function collectReachable(func: FunctionRoot, scan: ScanContext): ScanResult {
  const candidates: ReachableCandidate[] = [];
  const stops: UnfollowedCall[] = [];
  const seen = new Set<string>();

  const record = (outcome: CallOutcome): void => {
    if (outcome.kind === "stopped") {
      const stopKey = `${outcome.stop.reason}:${outcome.stop.callee}`;
      if (!seen.has(stopKey) && worthRecording(outcome.stop.reason)) {
        seen.add(stopKey);
        stops.push(outcome.stop);
      }
      return;
    }
    const key = nodeKey(outcome.candidate.func);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(outcome.candidate);
  };

  func.forEachDescendant((node) => {
    const jsx = resolveJsxReference(node);
    if (jsx !== null) {
      record(jsx.outcome);
      return;
    }
    if (!Node.isCallExpression(node)) {
      return;
    }
    const calleeText = normalizeCallee(node.getExpression().getText());
    const outcome = resolveCallee(node, calleeText, scan);
    if (outcome === null) {
      return;
    }
    // One record per callee, however many times the body calls it: a
    // loop calling the same unresolved method twenty times is one
    // thing a reader cannot see, not twenty.
    record(outcome);
  });

  return { candidates, stops };
}

/**
 * The callee as one line. A call written across several lines would put
 * its own newlines into a gap description otherwise.
 */
function normalizeCallee(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Build a library summary from a reached function
// ---------------------------------------------------------------------------

function extractReachableSummary(
  candidate: ReachableCandidate,
  options: ExtractorOptions | undefined,
  recognizers: ClosureRecognizers,
): BehavioralSummary {
  const unit: DiscoveredUnit = {
    func: candidate.func,
    kind: "library",
    name: candidate.name,
  };
  const raw = extractCodeStructure(
    unit,
    reachablePack,
    recognizers.invocation,
    recognizers.access,
    undefined,
    recognizers.resolveWrittenValue,
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

// The closure semantics, as rules: a function is reachable when it is
// an entry point (a pack-discovered seed) or when a reachable function
// calls it. Termination and the fixpoint are the engine's job; this
// file's job shrinks to *fact emission*: saying which call edges
// exist, one frontier function at a time.
const REACHABLE_RULES = [
  rule("reachable", [variable("f")], [lit("entry", variable("f"))]),
  rule(
    "reachable",
    [variable("g")],
    [
      lit("reachable", variable("f")),
      lit("calls", variable("f"), variable("g")),
    ],
  ),
];

/**
 * Expand the seed summaries into a superset that includes every
 * library function transitively reachable through static call edges.
 * Returns `seeds` concatenated with the new library summaries. Seeds
 * already in the set (either by pack discovery or by earlier closure
 * iterations) are never re-emitted.
 *
 * Structure: `entry` and `calls` facts go into a datalog database and
 * `REACHABLE_RULES` derive `reachable`. Because call edges are only
 * discoverable by scanning a function's body, emission is demand-driven:
 * scan the unscanned reachable frontier, add its edges, re-evaluate,
 * repeat until the reachable set stops growing.
 */
/**
 * The recognizers a reached function's body is read with. A reached
 * function is where a service keeps most of its work, so a pack's
 * recognizer has to fire there for the same reason it fires in a
 * handler: the queue write, the query, the config read is behaviour of
 * the code under analysis wherever it happens to be.
 */
export interface ClosureRecognizers {
  /**
   * What a name in a reached body was written as. A recognizer in a
   * unit's own body gets this, and one in a body the walk stepped into
   * needs the same, or a data access class keeping its table name in a
   * field reads as a class that states no table.
   */
  resolveWrittenValue?: (value: Node) => Node | null;
  /**
   * Every function a callee comes down to, for a call the type checker
   * only takes as far as an interface. One is followed; several is a
   * value with more than one possible source, said as a gap at the call
   * site. `alsoFrom` is the file the walk came in from, which is where
   * the dependency was constructed.
   */
  resolveCallableSources?: (value: Node, alsoFrom?: SourceFile) => Node[];
  invocation: InvocationRecognizer[];
  access: AccessRecognizer[];
}

const NO_RECOGNIZERS: ClosureRecognizers = { invocation: [], access: [] };

/**
 * The exported functions of files that only a recognizer pack applies
 * to. A recognizer reads calls inside units something else discovers,
 * so with nothing discovering, its effects had no function to live on
 * and the run wrote nothing. These become closure roots: walked with
 * the same recognizers, emitted as the same library summaries, and a
 * discovery pack added later claims its own units first and only
 * upgrades the attribution.
 */
export function recognizerOnlyRoots(
  packsByFile: ReadonlyMap<SourceFile, PatternPack[]>,
): ReachableCandidate[] {
  const roots: ReachableCandidate[] = [];
  for (const [sourceFile, packs] of packsByFile) {
    const recognizerOnly = packs.some(
      (pack) =>
        pack.discovery.length === 0 &&
        pack.discoverUnits === undefined &&
        ((pack.invocationRecognizers?.length ?? 0) > 0 ||
          (pack.accessRecognizers?.length ?? 0) > 0),
    );
    if (!recognizerOnly) {
      continue;
    }
    for (const declaration of sourceFile.getFunctions()) {
      if (declaration.isExported() && hasBody(declaration)) {
        roots.push({
          func: declaration,
          name: declaration.getName() ?? "<anon>",
        });
      }
    }
    for (const variableStatement of sourceFile.getVariableStatements()) {
      if (!variableStatement.isExported()) {
        continue;
      }
      for (const declaration of variableStatement.getDeclarations()) {
        const init = declaration.getInitializer();
        if (
          init !== undefined &&
          (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) &&
          hasBody(init)
        ) {
          roots.push({ func: init, name: declaration.getName() });
        }
      }
    }
  }
  return roots;
}

export function expandReachableClosure(
  seeds: BehavioralSummary[],
  project: Project,
  options?: ExtractorOptions,
  projectFileSet?: ReadonlySet<string>,
  facts?: ClosureFacts,
  recognizers: ClosureRecognizers = NO_RECOGNIZERS,
  alreadySummarized: BehavioralSummary[] = [],
  extraRoots: ReadonlyArray<ReachableCandidate> = [],
): BehavioralSummary[] {
  // One source-file enumeration and one per-file function index, shared
  // across every seed locate. Without them each seed re-scanned the
  // project's file list and re-walked the file it landed in.
  const lookup = createSourceFileLookup(project);

  // When the caller hands in shared facts, the closure's entry/calls
  // relations persist there for downstream rule passes (boundary
  // effects); otherwise they live and die locally.
  const db = facts?.db ?? new Database();
  const functionByKey = new Map<string, ReachableCandidate>();
  const seedKeys = new Set<string>();
  const scanned = new Set<string>();

  // What each scanned body called and could not be followed into. Held
  // per function key, because the summary it belongs on is only built
  // once the walk has finished.
  const stopsByKey = new Map<string, UnfollowedCall[]>();
  const summariesByKey = new Map<string, BehavioralSummary[]>();

  // The file a function was reached from, which is where whoever called
  // it built the dependencies it works through.
  const reachedFrom = new Map<string, SourceFile>();

  for (const seed of seeds) {
    const func = lookup.functionAt(seed.location);
    if (func !== null) {
      const key = nodeKey(func);
      seedKeys.add(key);
      functionByKey.set(key, { func, name: seed.identity.name });
      facts?.unitKeyBySummary.set(seed, key);
      rememberSummary(summariesByKey, key, seed);
      db.add("entry", [key]);
    }
  }

  // Roots the caller adds beyond the discovered seeds: the exported
  // functions of files a recognizer-only pack gated, in a run where
  // nothing discovers units there. They enter the walk like a seed and
  // are emitted like a reached function, so a run with only a
  // recognizer pack still describes the functions its effects live in.
  for (const root of extraRoots) {
    const key = nodeKey(root.func);
    if (!functionByKey.has(key)) {
      functionByKey.set(key, root);
    }
    db.add("entry", [key]);
  }

  // Units whose summaries a partial run serves from the cache: still
  // scanned through for reachability, but reaching one emits nothing,
  // since its summary already exists with its gaps on it.
  const knownKeys = new Set<string>();
  for (const summary of alreadySummarized) {
    const func = lookup.functionAt(summary.location);
    if (func !== null) {
      const key = nodeKey(func);
      knownKeys.add(key);
      facts?.unitKeyBySummary.set(summary, key);
    }
  }

  for (;;) {
    evaluate(db, REACHABLE_RULES);
    const frontier = db
      .facts("reachable")
      .map(([key]) => String(key))
      .filter((key) => !scanned.has(key));
    if (frontier.length === 0) {
      break;
    }
    for (const key of frontier) {
      scanned.add(key);
      const source = functionByKey.get(key);
      if (source === undefined) {
        continue;
      }
      const cameFrom = reachedFrom.get(key);
      const scan: ScanContext = {
        ...(recognizers.resolveCallableSources === undefined
          ? {}
          : { resolveCallableSources: recognizers.resolveCallableSources }),
        ...(cameFrom === undefined ? {} : { reachedFrom: cameFrom }),
      };
      const { candidates, stops } = scanWithRecording(key, facts, () =>
        collectReachable(source.func, scan),
      );
      if (stops.length > 0) {
        stopsByKey.set(key, stops);
      }
      for (const candidate of candidates) {
        const calleeKey = nodeKey(candidate.func);
        if (!functionByKey.has(calleeKey)) {
          functionByKey.set(calleeKey, candidate);
        }
        if (!reachedFrom.has(calleeKey)) {
          reachedFrom.set(calleeKey, source.func.getSourceFile());
        }
        db.add("calls", [key, calleeKey]);
      }
    }
  }

  // Emit library summaries in derivation order (the engine appends
  // facts as it derives them, so this tracks the old BFS order).
  const reached: BehavioralSummary[] = [];
  for (const [keyAtom] of db.facts("reachable")) {
    const key = String(keyAtom);
    if (seedKeys.has(key) || knownKeys.has(key)) {
      continue;
    }
    const candidate = functionByKey.get(key);
    if (candidate === undefined) {
      continue;
    }
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
    const summary = scanWithRecording(key, facts, () =>
      extractReachableSummary(candidate, options, recognizers),
    );
    facts?.unitKeyBySummary.set(summary, key);
    rememberSummary(summariesByKey, key, summary);
    reached.push(summary);
  }

  recordStops(stopsByKey, summariesByKey, options);

  return [...seeds, ...reached];
}

/**
 * Collect the files a scan read into the shared facts, per scanned
 * function, when a caller asked for them. With nobody collecting, the
 * scan runs bare and costs nothing extra.
 */
function scanWithRecording<T>(
  key: string,
  facts: ClosureFacts | undefined,
  fn: () => T,
): T {
  const filesByKey = facts?.filesByKey;
  if (filesByKey === undefined) {
    return fn();
  }
  const sink = createDependencySink();
  const result = withDependencySink(sink, fn);
  const bucket = filesByKey.get(key) ?? new Set<string>();
  for (const filePath of sink.files) {
    bucket.add(filePath);
  }
  filesByKey.set(key, bucket);
  return result;
}

function rememberSummary(
  summariesByKey: Map<string, BehavioralSummary[]>,
  key: string,
  summary: BehavioralSummary,
): void {
  const bucket = summariesByKey.get(key) ?? [];
  bucket.push(summary);
  summariesByKey.set(key, bucket);
}

/**
 * Put each body's unfollowed calls onto the summaries describing that
 * body. A stop deeper in the call chain stays where it happened rather
 * than climbing to every caller, so a reader gets the one place to look.
 */
function recordStops(
  stopsByKey: ReadonlyMap<string, UnfollowedCall[]>,
  summariesByKey: ReadonlyMap<string, BehavioralSummary[]>,
  options: ExtractorOptions | undefined,
): void {
  if (options?.gapHandling === "silent") {
    return;
  }
  for (const [key, stops] of stopsByKey) {
    for (const summary of summariesByKey.get(key) ?? []) {
      summary.gaps.push(...stops.map(unfollowedCallGap));
    }
  }
}
