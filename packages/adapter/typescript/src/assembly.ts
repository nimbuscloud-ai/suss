// assembly.ts — Compose Steps 1-4 into RawBranch[] (Task 2.5)

import {
  collectAncestorConditionInfos,
  collectEarlyReturnConditionInfos,
  conditionInfoToRawCondition,
} from "./conditions.js";
import {
  extractInvocationEffects,
  runInvocationRecognizers,
} from "./resolve/invocationEffects.js";
import {
  findTerminals,
  functionMayFallThrough,
  makeFallthroughTerminal,
} from "./terminals/index.js";

import type { Effect } from "@suss/behavioral-ir";
import type {
  InvocationRecognizer,
  RawBranch,
  RawCondition,
  RawEffect,
  TerminalPattern,
} from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Extract all raw branches from a function, composing:
 *   1. findTerminals — locate terminal nodes
 *   2. collectEarlyReturnConditionInfos — prior guard clauses
 *   3. collectAncestorConditionInfos — enclosing branch conditions
 *   4. parseConditionExpression — Expression → Predicate
 *   5. extractInvocationEffects — bare expression-statement calls
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
): RawBranch[] {
  const terminals = findTerminals(func, terminalPatterns);
  const invocations = extractInvocationEffects(func);
  const recognized = runInvocationRecognizers(func, invocationRecognizers);

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
  // handlers treat implicit return as normal (synthetic default
  // transition carries the body's side effects). Pack opt-in via
  // the `functionFallthrough` match keeps the decision close to
  // where the semantics are declared.
  const wantsFallthrough = terminalPatterns.some(
    (p) => p.match.type === "functionFallthrough",
  );
  if (wantsFallthrough && functionMayFallThrough(func)) {
    const hasDefaultTerminal = terminals.some(({ node }) => {
      const earlyReturnInfos = collectEarlyReturnConditionInfos(node, func);
      const ancestorInfos = collectAncestorConditionInfos(node, func);
      const allConditions = [...earlyReturnInfos, ...ancestorInfos];
      return (
        allConditions.length === 0 ||
        allConditions.every(
          (c) => c.source === "earlyReturn" || c.source === "earlyThrow",
        )
      );
    });
    if (!hasDefaultTerminal) {
      terminals.push(makeFallthroughTerminal(func));
    }
  }

  const rawBranches: RawBranch[] = terminals.map(({ node, terminal }) => {
    const earlyReturnInfos = collectEarlyReturnConditionInfos(node, func);
    const ancestorInfos = collectAncestorConditionInfos(node, func);

    // Early returns first (they gate everything that follows), then ancestors
    const conditions: RawCondition[] = [
      ...earlyReturnInfos.map(conditionInfoToRawCondition),
      ...ancestorInfos.map(conditionInfoToRawCondition),
    ];

    const isDefault =
      conditions.length === 0 ||
      conditions.every(
        (c) => c.source === "earlyReturn" || c.source === "earlyThrow",
      );

    return {
      conditions,
      terminal,
      effects: [] as RawEffect[],
      location: terminal.location,
      isDefault,
    };
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
