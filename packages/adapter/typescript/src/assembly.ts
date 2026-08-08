/**
 * Turns one function into the list of branches a summary is built from.
 *
 * Terminal matching, path-condition enumeration, predicate parsing and
 * effect capture each live in their own module. This one runs them over
 * the same function and lines the results up: every terminal gets the
 * conditions on each path that reaches it, and the calls in the body get
 * attached to the branch they fire on.
 */

import { Node } from "ts-morph";

import {
  type ConditionInfo,
  conditionInfoToRawCondition,
} from "./conditions.js";
import { computePathConditions } from "./paths/pathConditions.js";
import {
  extractInvocationEffects,
  runAccessRecognizers,
  runInvocationRecognizers,
} from "./resolve/invocationEffects.js";
import {
  type FoundTerminal,
  findTerminals,
  functionMayFallThrough,
  makeFallthroughTerminal,
} from "./terminals/index.js";
import {
  type DescentBarriers,
  isDescentStop,
  NO_BARRIERS,
  startsItsOwnScope,
} from "./walk/descent.js";

import type { Effect } from "@suss/behavioral-ir";
import type {
  AccessRecognizer,
  BodyContent,
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

const isDefaultConditionList = (conditions: ConditionInfo[]): boolean =>
  conditions.length === 0 ||
  conditions.every(
    (c) => c.source === "earlyReturn" || c.source === "earlyThrow",
  );

/**
 * Whether this unit has a body, and whether that body does anything. A
 * declaration with nothing behind it and a body with nothing in it both
 * produce an empty summary, and the confidence we put on that summary
 * is different in each case.
 */
export function bodyContentOf(func: FunctionRoot): BodyContent {
  const body = func.getBody?.();
  if (body === undefined) {
    return "absent";
  }
  // A concise arrow has an expression where the block would be, and
  // evaluating that expression is work, so it is never "empty".
  if (!Node.isBlock(body)) {
    return "statements";
  }
  return body.getStatements().length === 0 ? "empty" : "statements";
}

/**
 * How many return statements no terminal pattern matched. A return
 * inside a nested scope belongs to that scope and is not counted here,
 * which is the same rule the terminal search follows.
 */
export function countUnmatchedReturns(
  func: FunctionRoot,
  terminals: FoundTerminal[],
  barriers: DescentBarriers = NO_BARRIERS,
): number {
  const body = func.getBody?.();
  if (body === undefined) {
    return 0;
  }

  const claimed = new Set<Node>();
  for (const { source } of terminals) {
    if (source !== undefined) {
      claimed.add(source);
    }
  }

  // A concise arrow has no return statement to look for, so the body
  // expression itself is the one thing a terminal either matched or not.
  if (Node.isArrowFunction(func) && Node.isExpression(body)) {
    return claimed.has(body) ? 0 : 1;
  }

  let unmatched = 0;
  body.forEachDescendant((node, traversal) => {
    if (isDescentStop(node, func, barriers)) {
      traversal.skip();
      return;
    }
    // A return in a nested scope is that scope's, and it gets its own
    // summary if anything discovers it, so counting it here would
    // report the same return twice.
    if (startsItsOwnScope(node)) {
      traversal.skip();
      return;
    }
    if (!Node.isReturnStatement(node)) {
      return;
    }
    // A bare `return;` produces the same result as falling off the end
    // of the function, so nothing was missed by not matching it.
    if (node.getExpression() === undefined) {
      return;
    }
    if (!claimed.has(node)) {
      unmatched++;
    }
  });
  return unmatched;
}

/**
 * The branches a function produces, alongside the terminals they came
 * from. A caller that wants to know which returns went unclaimed needs
 * the terminals, and searching for them a second time costs about as
 * much as this whole pass.
 */
export interface RawBranchResult {
  branches: RawBranch[];
  terminals: FoundTerminal[];
}

/**
 * Every branch a function produces: one per path that reaches a
 * terminal, with the conditions on that path and the effects that fire
 * along it. A branch is `isDefault` when it has no conditions at all,
 * or when every condition on it came from an early return or throw,
 * since those are the paths that run when no guard fired.
 */
export function extractRawBranches(
  func: FunctionRoot,
  terminalPatterns: TerminalPattern[],
  invocationRecognizers: InvocationRecognizer[] = [],
  accessRecognizers: AccessRecognizer[] = [],
  barriers: DescentBarriers = NO_BARRIERS,
  resolveWrittenValue?: (value: Node) => Node | null,
): RawBranchResult {
  const terminals = findTerminals(func, terminalPatterns, barriers);
  const invocations = extractInvocationEffects(func, barriers);
  const recognized = [
    ...runInvocationRecognizers(
      func,
      invocationRecognizers,
      barriers,
      resolveWrittenValue,
    ),
    ...runAccessRecognizers(func, accessRecognizers, barriers),
  ];

  // One condition list per path from entry to terminal. Anything the
  // path engine cannot enumerate comes back as the enclosing conditions
  // plus an opaque conjunct, so there is no second code path here.
  const { byTerminal } = computePathConditions(
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
  // synthetic terminal: `no matching terminals` stays empty so
  // downstream gap detection flags the handler); React event
  // handlers treat implicit return as normal (synthesised default
  // transition records the body's side effects). Pack opt-in via
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
      // condition lists are the paths that fall through the body's end.
      const pathResult = computePathConditions(func, [synthetic.node]);
      byTerminal.set(
        synthetic.node,
        pathResult.fallthrough.length > 0 ? pathResult.fallthrough : [[]],
      );
    }
  }

  const rawBranches: RawBranch[] = terminals.flatMap(
    ({ node, terminal, whenAlso }) => {
      // Dead-code terminals (no entry path reaches them) produce no
      // branches: a terminal that cannot fire is not behavior.
      const conditionLists = byTerminal.get(node) ?? [];
      return conditionLists.map((infos): RawBranch => {
        // When two terminals share a node, `whenAlso` is the only thing
        // that tells them apart. The path conditions cannot, because
        // both were reached exactly the same way.
        const conditions: RawCondition[] = [
          ...infos.map(conditionInfoToRawCondition),
          ...(whenAlso === undefined ? [] : [whenAlso]),
        ];
        return {
          conditions,
          terminal,
          effects: [] as RawEffect[],
          location: terminal.location,
          isDefault: isDefaultConditionList(infos),
        };
      });
    },
  );

  // Two branches with the same conditions, terminal and location are
  // one behaviour, however many paths the walk arrived by. Without
  // this, a status written as a choice repeats every arm on every path.
  const seenBranches = new Set<string>();
  const distinctBranches = rawBranches.filter((branch) => {
    const key = [
      branch.terminal.kind,
      JSON.stringify(branch.terminal.statusCode),
      branch.location.start,
      branch.location.end,
      branch.conditions.map((c) => `${c.polarity}:${c.sourceText}`).join(";"),
    ].join("\u001f");
    if (seenBranches.has(key)) {
      return false;
    }
    seenBranches.add(key);
    return true;
  });

  // Attach invocation effects to the default branch. A default branch
  // is the code path that runs when no early-return / guard clause
  // fires: exactly the path every body-top-level call executes on.
  // Non-default branches (explicit early returns) don't fire those
  // calls, so they stay effect-free. Calls nested inside `if`/`for`
  // blocks are attributed to the default branch too, which is coarser
  // than it should be and waits on branch-scoped effect attribution.
  //
  // Exclude calls whose location coincides with a terminal's: e.g.
  // Express's `res.json(body)` is matched as a `parameterMethodCall`
  // terminal and shouldn't be double-counted as a side-effect
  // invocation.
  if (invocations.length > 0) {
    const defaultBranch = distinctBranches.find((b) => b.isDefault);
    if (defaultBranch !== undefined) {
      const terminalLines = new Set(
        distinctBranches.map((b) => b.terminal.location.start),
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
  // because they're additive to the invocation effect: a Prisma
  // call that's also somehow a terminal would emit BOTH a typed
  // interaction (paired against the schema) AND any terminal-
  // shaped invocation, and that's the right behavior.
  if (recognized.length > 0) {
    const defaultBranch = distinctBranches.find((b) => b.isDefault);
    if (defaultBranch !== undefined) {
      const extra: Effect[] = recognized.map((r) => r.effect);
      defaultBranch.extraEffects = [
        ...(defaultBranch.extraEffects ?? []),
        ...extra,
      ];
    }
  }

  return { branches: distinctBranches, terminals };
}
