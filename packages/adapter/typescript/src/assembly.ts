// assembly.ts — Compose Steps 1-4 into RawBranch[] (Task 2.5)

import {
  type ConditionInfo,
  collectAncestorConditionInfos,
  collectEarlyReturnConditionInfos,
  conditionInfoToRawCondition,
} from "./conditions.js";
import { computePathConditions } from "./paths/pathConditions.js";
import {
  extractInvocationEffects,
  runAccessRecognizers,
  runInvocationRecognizers,
} from "./resolve/invocationEffects.js";
import {
  findTerminals,
  functionMayFallThrough,
  makeFallthroughTerminal,
} from "./terminals/index.js";
import { type DescentBarriers, NO_BARRIERS } from "./walk/descent.js";

import type { Effect } from "@suss/behavioral-ir";
import type {
  AccessRecognizer,
  InvocationRecognizer,
  RawBranch,
  RawCondition,
  RawEffect,
  TerminalPattern,
} from "@suss/extractor";
import type { Node } from "ts-morph";
import type { FunctionRoot } from "./conditions.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Compose the per-terminal condition lists. Primary engine: CFG-path
 * enumeration (`paths/pathConditions.ts`) — one condition list per
 * entry→terminal path, which closes the nested-guard and loop-return
 * soundness gaps and drops dead-code terminals. Falls back to the
 * legacy early-return + ancestor collectors when the function's
 * statement flow contains constructs the path engine doesn't model
 * (switch / try / labels / break / continue), when the path budget is
 * exceeded, or when `SUSS_PATH_ENGINE=legacy` is set (escape hatch;
 * see status.md decision #56).
 */
function conditionListsPerTerminal(
  func: FunctionRoot,
  terminalNodes: readonly Node[],
): { byTerminal: Map<Node, ConditionInfo[][]>; usedCfg: boolean } {
  const pathResult =
    process.env.SUSS_PATH_ENGINE === "legacy"
      ? null
      : computePathConditions(func, terminalNodes);

  if (pathResult !== null) {
    return { byTerminal: pathResult.byTerminal, usedCfg: true };
  }

  const byTerminal = new Map<Node, ConditionInfo[][]>();
  for (const node of terminalNodes) {
    const earlyReturnInfos = collectEarlyReturnConditionInfos(node, func);
    const ancestorInfos = collectAncestorConditionInfos(node, func);
    byTerminal.set(node, [[...earlyReturnInfos, ...ancestorInfos]]);
  }
  return { byTerminal, usedCfg: false };
}

const isDefaultConditionList = (conditions: ConditionInfo[]): boolean =>
  conditions.length === 0 ||
  conditions.every(
    (c) => c.source === "earlyReturn" || c.source === "earlyThrow",
  );

/**
 * Extract all raw branches from a function, composing:
 *   1. findTerminals — locate terminal nodes
 *   2. conditionListsPerTerminal — per-path conditions (CFG engine,
 *      legacy collectors as the conservative fallback)
 *   3. parseConditionExpression — Expression → Predicate
 *   4. extractInvocationEffects — bare expression-statement calls
 *      (Phase 1.5b — attaches to the default branch so handler /
 *      useEffect bodies carry their side-effect set)
 *
 * `isDefault` is true when the branch has no conditions, or all
 * conditions come from early returns/throws.
 */
export function extractRawBranches(
  func: FunctionRoot,
  terminalPatterns: TerminalPattern[],
  invocationRecognizers: InvocationRecognizer[] = [],
  accessRecognizers: AccessRecognizer[] = [],
  barriers: DescentBarriers = NO_BARRIERS,
): RawBranch[] {
  const terminals = findTerminals(func, terminalPatterns, barriers);
  const invocations = extractInvocationEffects(func, barriers);
  const recognized = [
    ...runInvocationRecognizers(func, invocationRecognizers, barriers),
    ...runAccessRecognizers(func, accessRecognizers, barriers),
  ];

  const { byTerminal } = conditionListsPerTerminal(
    func,
    terminals.map(({ node }) => node),
  );

  // Synthesise a fall-through terminal when (a) the pack opted in by
  // including `{ type: "functionFallthrough" }` in its terminals,
  // (b) no existing terminal covers the default-path exit, and
  // (c) the function's last statement is non-terminating.
  //
  // Fall-through is a JS language fact (every function implicitly
  // returns `undefined`) but whether it counts as a *terminal* is
  // pack-specific: HTTP handlers treat no-response as a bug (no
  // synthetic terminal — `no matching terminals` stays empty so
  // downstream gap detection flags the handler); React event
  // handlers treat implicit return as normal (synthesised default
  // transition carries the body's side effects). Pack opt-in via
  // the `functionFallthrough` match keeps the decision close to
  // where the semantics are declared.
  const wantsFallthrough = terminalPatterns.some(
    (p) => p.match.type === "functionFallthrough",
  );
  if (wantsFallthrough && functionMayFallThrough(func)) {
    const hasDefaultTerminal = terminals.some(({ node }) =>
      (byTerminal.get(node) ?? []).some(isDefaultConditionList),
    );
    if (!hasDefaultTerminal) {
      const synthetic = makeFallthroughTerminal(func);
      terminals.push(synthetic);
      // The synthetic terminal anchors at the body itself; its
      // condition lists are the paths that fall through the body's
      // end (already computed by the CFG engine; empty conditions
      // under legacy — same as before).
      const pathResult =
        process.env.SUSS_PATH_ENGINE === "legacy"
          ? null
          : computePathConditions(func, [synthetic.node]);
      byTerminal.set(
        synthetic.node,
        pathResult !== null && pathResult.fallthrough.length > 0
          ? pathResult.fallthrough
          : [[]],
      );
    }
  }

  const rawBranches: RawBranch[] = terminals.flatMap(({ node, terminal }) => {
    // Dead-code terminals (no entry path reaches them) produce no
    // branches under the CFG engine — a terminal that cannot fire is
    // not behavior. Legacy always yields exactly one list.
    const conditionLists = byTerminal.get(node) ?? [];
    return conditionLists.map((infos): RawBranch => {
      const conditions: RawCondition[] = infos.map(conditionInfoToRawCondition);
      return {
        conditions,
        terminal,
        effects: [] as RawEffect[],
        location: terminal.location,
        isDefault: isDefaultConditionList(infos),
      };
    });
  });

  // Attach invocation effects to the default branch. A default branch
  // is the code path that runs when no early-return / guard clause
  // fires — exactly the path every body-top-level call executes on.
  // Non-default branches (explicit early returns) don't fire those
  // calls, so they stay effect-free. Calls nested inside `if`/`for`
  // blocks are attributed to the default branch too in v0 — a coarse
  // over-approximation we'll refine when branch-scoped effect
  // attribution becomes load-bearing (Phase 1.5c).
  //
  // Exclude calls whose location coincides with a terminal's — e.g.
  // Express's `res.json(body)` is matched as a `parameterMethodCall`
  // terminal and shouldn't be double-counted as a side-effect
  // invocation.
  if (invocations.length > 0) {
    const defaultBranch = rawBranches.find((b) => b.isDefault);
    if (defaultBranch !== undefined) {
      const terminalLines = new Set(
        rawBranches.map((b) => b.terminal.location.start),
      );
      // Container-building calls (spread / array-element composition)
      // are never themselves terminals, so they skip the terminal-line
      // dedup that catches `res.json(body)`-as-both-terminal-and-call.
      defaultBranch.effects = invocations
        .filter((i) => i.neverTerminal || !terminalLines.has(i.line))
        .map((i) => i.effect);
    }
  }

  // Recognized typed effects (interaction(class: ...)) attach to
  // the same default branch. They bypass the terminal-line dedup
  // because they're additive to the invocation effect — a Prisma
  // call that's also somehow a terminal would emit BOTH a typed
  // interaction (paired against the schema) AND any terminal-
  // shaped invocation, and that's the right behavior.
  if (recognized.length > 0) {
    const defaultBranch = rawBranches.find((b) => b.isDefault);
    if (defaultBranch !== undefined) {
      const extra: Effect[] = recognized.map((r) => r.effect);
      defaultBranch.extraEffects = [
        ...(defaultBranch.extraEffects ?? []),
        ...extra,
      ];
    }
  }

  return rawBranches;
}
