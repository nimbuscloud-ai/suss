// assembly.ts — Compose Steps 1-4 into RawBranch[] (Task 2.5)

import {
  type ConditionInfo,
  collectAncestorConditionInfos,
  collectEarlyReturnConditionInfos,
} from "./conditions.js";
import { parseConditionExpression } from "./predicates.js";
import { findTerminals } from "./terminals.js";

import type { RawBranch, RawCondition, TerminalPattern } from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function conditionInfoToRawCondition(info: ConditionInfo): RawCondition {
  const structured =
    info.expression !== null ? parseConditionExpression(info.expression) : null;

  return {
    sourceText: info.sourceText,
    structured,
    polarity: info.polarity,
    source: info.source,
  };
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Extract all raw branches from a function, composing:
 *   1. findTerminals — locate terminal nodes
 *   2. collectEarlyReturnConditionInfos — prior guard clauses
 *   3. collectAncestorConditionInfos — enclosing branch conditions
 *   4. parseConditionExpression — Expression → Predicate
 *
 * Effects are empty for v0. `isDefault` is true when the branch has no
 * conditions, or all conditions come from early returns/throws.
 */
export function extractRawBranches(
  func: FunctionRoot,
  terminalPatterns: TerminalPattern[],
): RawBranch[] {
  const terminals = findTerminals(func, terminalPatterns);

  return terminals.map(({ node, terminal }) => {
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
      effects: [],
      location: terminal.location,
      isDefault,
    };
  });
}
