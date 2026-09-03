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
import { offsetKeyFor, offsetKeyOf } from "../walk/nodeKeys.js";
import {
  functionTargetOf,
  type ReachableCandidate,
  resolveDecl,
} from "./functionBehind.js";
import {
  classifyStop,
  declarationsBehind,
  hasBody,
  isDeclaredShape,
  parameterIndexOf,
  type UnfollowedCall,
  unfollowedCallGap,
  worthRecording,
} from "./unfollowedCall.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
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
 * closure describes rather than drops. A stop still says where the
 * checker found the callee declared, when it found anything, so the
 * call can be told apart from one nothing declares.
 */
type CallOutcome =
  | { readonly kind: "followed"; readonly candidate: ReachableCandidate }
  | {
      readonly kind: "stopped";
      readonly stop: UnfollowedCall;
      readonly declaration: Node | null;
      /** Set for a `callerSupplied` stop: the parameter's index in `scanning`. */
      readonly parameterIndex?: number;
    };

/** Where a call was declared, spelled the way a summary spells its unit. */
type CallTarget = NonNullable<
  Extract<Effect, { type: "invocation" }>["declaredAt"]
>;

function targetOf(node: Node): CallTarget {
  return {
    file: node.getSourceFile().getFilePath(),
    span: { start: node.getStart(), end: node.getEnd() },
  };
}

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
        declaration: declarationToReport(declarations, calleeName, scan),
      };
    }
  }

  const reason = classifyStop(declarations, scan.scanning);
  const parameterIndex =
    reason === "callerSupplied"
      ? parameterIndexOf(declarations, scan.scanning)
      : undefined;
  return {
    kind: "stopped",
    stop: { callee: calleeName, reason },
    declaration: declarationToReport(declarations, calleeName, scan),
    ...(parameterIndex === undefined ? {} : { parameterIndex }),
  };
}

/**
 * The declaration a stop says the callee has. An import of a sibling
 * workspace package lands on its built declaration file, where no
 * summary lives, so the stop reports the source declaration behind it
 * instead, spelled as the function the summary there was built on.
 * A declaration that maps to several sources, or to none, is kept.
 */
function declarationToReport(
  declarations: Node[],
  calleeName: string,
  scan: ScanContext,
): Node | null {
  const first = declarations[0];
  if (first === undefined) {
    return null;
  }
  const sources = scan.sourceDeclarationsBehind?.(first) ?? [first];
  const only = sources.length === 1 ? sources[0] : undefined;
  if (only === undefined || only === first) {
    return first;
  }
  return resolveDecl(only, calleeName)?.func ?? only;
}

/** Where the callee an outcome came from is declared, when anything declares it. */
function declaredAtOf(outcome: CallOutcome): CallTarget | null {
  if (outcome.kind === "followed") {
    return targetOf(outcome.candidate.func);
  }
  return outcome.declaration === null ? null : targetOf(outcome.declaration);
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
 * it was handed was constructed. `scanning` is the function whose body
 * this pass is reading, which says whose parameters a callee could be.
 */
interface ScanContext {
  resolveCallableSources?: (value: Node, alsoFrom?: SourceFile) => Node[];
  sourceDeclarationsBehind?: (declaration: Node) => Node[];
  reachedFrom?: SourceFile;
  scanning?: FunctionRoot;
}

/**
 * Everything one pass over a body found: edges to walk, stops, where
 * each callee the body writes is declared, where an argument that is
 * itself a project function is declared (by callee text and its
 * position in that call), calls made through one of this body's own
 * parameters, and the (callee, position) pairs this body passes a
 * function into. A callee or argument text the body resolved to two
 * different declarations maps to null.
 */
interface ScanResult {
  readonly candidates: ReachableCandidate[];
  readonly stops: UnfollowedCall[];
  readonly targets: ReadonlyMap<string, CallTarget | null>;
  readonly argTargets: ReadonlyMap<
    string,
    ReadonlyMap<number, CallTarget | null>
  >;
  readonly parameterCalls: ReadonlyArray<{
    callee: string;
    parameterIndex: number;
  }>;
  readonly passedPositions: ReadonlySet<string>;
}

/** The key a (callee function, parameter position) pair is tracked under. */
function passedPositionKey(target: CallTarget, position: number): string {
  return `${offsetKeyFor(target.file, target.span)}#${position}`;
}

/**
 * A JSX reference is a render-time call: `<UserCard/>` runs `UserCard`
 * the way `userCard()` would, so the closure follows it. Host tags are
 * lowercase and member tags (`<Foo.Bar/>`) wait on richer resolution.
 */
function resolveJsxReference(
  node: Node,
  scan: ScanContext,
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
      declaration: declarationToReport(declarations, name, scan),
    },
  };
}

function collectReachable(func: FunctionRoot, scan: ScanContext): ScanResult {
  const inFunc: ScanContext = { ...scan, scanning: func };
  const candidates: ReachableCandidate[] = [];
  const stops: UnfollowedCall[] = [];
  const targets = new Map<string, CallTarget | null>();
  const argTargets = new Map<string, Map<number, CallTarget | null>>();
  const parameterCalls: Array<{ callee: string; parameterIndex: number }> = [];
  const passedPositions = new Set<string>();
  const seen = new Set<string>();
  const parameterCallsSeen = new Set<string>();

  // The invocation effects on this body's summary join here by callee
  // text, so the same text resolving two ways (a shadowed name) has to
  // say so rather than pick one.
  const rememberTarget = (calleeText: string, outcome: CallOutcome): void => {
    const target = declaredAtOf(outcome);
    if (target === null) {
      return;
    }
    const known = targets.get(calleeText);
    if (known === undefined) {
      targets.set(calleeText, target);
      return;
    }
    if (
      known !== null &&
      offsetKeyFor(known.file, known.span) !==
        offsetKeyFor(target.file, target.span)
    ) {
      targets.set(calleeText, null);
    }
  };

  // Same shadow handling as `rememberTarget`, one level down: the
  // argument at this position in calls written as `calleeText`.
  const rememberArgTarget = (
    calleeText: string,
    position: number,
    target: CallTarget,
  ): void => {
    const byPosition = argTargets.get(calleeText) ?? new Map();
    argTargets.set(calleeText, byPosition);
    const known = byPosition.get(position);
    if (known === undefined) {
      byPosition.set(position, target);
      return;
    }
    if (
      known !== null &&
      offsetKeyFor(known.file, known.span) !==
        offsetKeyFor(target.file, target.span)
    ) {
      byPosition.set(position, null);
    }
  };

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

  // An identifier argument that is a project function is reachable the
  // same way a callee is, and its declaration joins a `passes` fact to
  // whichever parameter the callee calls it through.
  const recordPassedArgs = (
    call: Node,
    calleeText: string,
    calleeOutcome: CallOutcome,
  ): void => {
    if (!Node.isCallExpression(call)) {
      return;
    }
    const calleeTarget = declaredAtOf(calleeOutcome);
    call.getArguments().forEach((arg, position) => {
      if (!Node.isIdentifier(arg)) {
        return;
      }
      const resolved = functionTargetOf(arg);
      if (resolved === null) {
        return;
      }
      record({ kind: "followed", candidate: resolved });
      rememberArgTarget(calleeText, position, targetOf(resolved.func));
      if (calleeTarget !== null) {
        passedPositions.add(passedPositionKey(calleeTarget, position));
      }
    });
  };

  func.forEachDescendant((node) => {
    const jsx = resolveJsxReference(node, inFunc);
    if (jsx !== null) {
      record(jsx.outcome);
      return;
    }
    if (!Node.isCallExpression(node)) {
      return;
    }
    const calleeText = normalizeCallee(node.getExpression().getText());
    const outcome = resolveCallee(node, calleeText, inFunc);
    if (outcome === null) {
      return;
    }
    // One record per callee, however many times the body calls it: a
    // loop calling the same unresolved method twenty times is one
    // thing a reader cannot see, not twenty.
    record(outcome);
    rememberTarget(calleeText, outcome);
    recordPassedArgs(node, calleeText, outcome);

    if (
      outcome.kind === "stopped" &&
      outcome.stop.reason === "callerSupplied" &&
      outcome.parameterIndex !== undefined &&
      !parameterCallsSeen.has(calleeText)
    ) {
      parameterCallsSeen.add(calleeText);
      parameterCalls.push({
        callee: calleeText,
        parameterIndex: outcome.parameterIndex,
      });
    }
  });

  return {
    candidates,
    stops,
    targets,
    argTargets,
    parameterCalls,
    passedPositions,
  };
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
  /**
   * The source declarations behind one a sibling workspace package
   * publishes as a built declaration file, so a call the walk stops at
   * is recorded where its summary is, rather than at a bodiless twin.
   */
  sourceDeclarationsBehind?: (declaration: Node) => Node[];
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
  const targetsByKey = new Map<
    string,
    ReadonlyMap<string, CallTarget | null>
  >();
  const argTargetsByKey = new Map<
    string,
    ReadonlyMap<string, ReadonlyMap<number, CallTarget | null>>
  >();
  const parameterCallsByKey = new Map<
    string,
    ReadonlyArray<{ callee: string; parameterIndex: number }>
  >();
  // Every (callee function, position) some body passes a named project
  // function into. An inline arrow or a variable does not count, so a
  // parameter call missing here is a gap even when a caller supplies one.
  const passedPositions = new Set<string>();
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
        ...(recognizers.sourceDeclarationsBehind === undefined
          ? {}
          : { sourceDeclarationsBehind: recognizers.sourceDeclarationsBehind }),
        ...(cameFrom === undefined ? {} : { reachedFrom: cameFrom }),
      };
      const {
        candidates,
        stops,
        targets,
        argTargets,
        parameterCalls,
        passedPositions: scanPassedPositions,
      } = scanWithRecording(key, facts, () =>
        collectReachable(source.func, scan),
      );
      if (stops.length > 0) {
        stopsByKey.set(key, stops);
      }
      targetsByKey.set(key, targets);
      argTargetsByKey.set(key, argTargets);
      if (parameterCalls.length > 0) {
        parameterCallsByKey.set(key, parameterCalls);
      }
      for (const position of scanPassedPositions) {
        passedPositions.add(position);
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
  recordTargets(targetsByKey, summariesByKey);
  recordArgTargets(argTargetsByKey, summariesByKey);
  recordCalleeParameters(parameterCallsByKey, summariesByKey);
  recordParameterGaps(
    parameterCallsByKey,
    summariesByKey,
    passedPositions,
    options,
  );

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

/**
 * Put where each call was declared onto the invocation effects of the
 * summaries describing that body. Naming later turns the declaration
 * into the summary at that place, so the link a reader follows comes
 * from the checker and never from a name that happened to match. A
 * call the checker could not place stays bare, and naming falls back
 * to the name within the same file for that one only.
 */
function recordTargets(
  targetsByKey: ReadonlyMap<string, ReadonlyMap<string, CallTarget | null>>,
  summariesByKey: ReadonlyMap<string, BehavioralSummary[]>,
): void {
  for (const [key, targets] of targetsByKey) {
    for (const summary of summariesByKey.get(key) ?? []) {
      for (const transition of summary.transitions) {
        for (const effect of transition.effects) {
          if (effect.type !== "invocation") {
            continue;
          }
          const target = targets.get(normalizeCallee(effect.callee));
          if (target !== undefined && target !== null) {
            effect.declaredAt = target;
          }
        }
      }
    }
  }
}

/**
 * Put where each identifier argument that is a project function is
 * declared onto the matching invocation effect, keyed by its position.
 * Naming later turns each one into `argsSummary`, the same way it turns
 * `declaredAt` into `summary`.
 */
function recordArgTargets(
  argTargetsByKey: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyMap<number, CallTarget | null>>
  >,
  summariesByKey: ReadonlyMap<string, BehavioralSummary[]>,
): void {
  for (const [key, argTargets] of argTargetsByKey) {
    for (const summary of summariesByKey.get(key) ?? []) {
      for (const transition of summary.transitions) {
        for (const effect of transition.effects) {
          if (effect.type !== "invocation") {
            continue;
          }
          const byPosition = argTargets.get(normalizeCallee(effect.callee));
          if (byPosition === undefined) {
            continue;
          }
          const argsDeclaredAt: Record<string, CallTarget> = {};
          for (const [position, target] of byPosition) {
            if (target !== null) {
              argsDeclaredAt[position] = target;
            }
          }
          if (Object.keys(argsDeclaredAt).length > 0) {
            effect.argsDeclaredAt = argsDeclaredAt;
          }
        }
      }
    }
  }
}

/**
 * Say, on the matching invocation effect, which of this unit's own
 * parameters a `callerSupplied` call goes through. A caller elsewhere
 * that passes a function into that position joins to this call by it.
 */
function recordCalleeParameters(
  parameterCallsByKey: ReadonlyMap<
    string,
    ReadonlyArray<{ callee: string; parameterIndex: number }>
  >,
  summariesByKey: ReadonlyMap<string, BehavioralSummary[]>,
): void {
  for (const [key, parameterCalls] of parameterCallsByKey) {
    const byCallee = new Map(
      parameterCalls.map(({ callee, parameterIndex }) => [
        callee,
        parameterIndex,
      ]),
    );
    for (const summary of summariesByKey.get(key) ?? []) {
      for (const transition of summary.transitions) {
        for (const effect of transition.effects) {
          if (effect.type !== "invocation") {
            continue;
          }
          const parameterIndex = byCallee.get(normalizeCallee(effect.callee));
          if (parameterIndex !== undefined) {
            effect.calleeParameter = parameterIndex;
          }
        }
      }
    }
  }
}

/**
 * A call through one of this unit's own parameters is a gap only once
 * the whole run is scanned and nothing anywhere passes a function into
 * that position (#809): until then it is the ordinary `callerSupplied`
 * stop, which nothing records.
 */
function recordParameterGaps(
  parameterCallsByKey: ReadonlyMap<
    string,
    ReadonlyArray<{ callee: string; parameterIndex: number }>
  >,
  summariesByKey: ReadonlyMap<string, BehavioralSummary[]>,
  passedPositions: ReadonlySet<string>,
  options: ExtractorOptions | undefined,
): void {
  if (options?.gapHandling === "silent") {
    return;
  }
  for (const [key, parameterCalls] of parameterCallsByKey) {
    const unbound = parameterCalls.filter(
      ({ parameterIndex }) => !passedPositions.has(`${key}#${parameterIndex}`),
    );
    if (unbound.length === 0) {
      continue;
    }
    for (const summary of summariesByKey.get(key) ?? []) {
      summary.gaps.push(
        ...unbound.map(({ callee }) =>
          unfollowedCallGap({ callee, reason: "unboundParameter" }),
        ),
      );
    }
  }
}
