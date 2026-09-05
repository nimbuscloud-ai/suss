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

import { guardsHoldOn, runsBefore } from "@suss/extractor";

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
import type { ResolutionStore } from "./facts/store.js";
import type {
  AnchorCallsOf,
  OriginatesFrom,
} from "./resolve/invocationEffects.js";
import type { ResolveCallee } from "./terminals/helperResolution.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/** Only an invocation records what had to be true before it ran. */
const preconditionsOf = (effect: RawEffect): RawCondition[] | undefined =>
  effect.type === "invocation" ? effect.preconditions : undefined;

/** Where a call is and what it is written under. */
interface CallSite {
  line: number;
  alwaysRuns: boolean;
  preconditions: RawCondition[] | undefined;
}

/**
 * Whether the call at `site` runs on the way to `branch`'s terminal.
 * Both tests, and why each is needed, are in the `@suss/extractor`
 * README.
 */
function firesOn(site: CallSite, branch: RawBranch): boolean {
  if (!guardsHoldOn(site.preconditions, branch.conditions)) {
    return false;
  }
  return site.alwaysRuns || runsBefore(site.line, branch.terminal.location.end);
}

/**
 * Whether `call` is a terminal the reader matched, or a link in the
 * receiver chain of one: `res.status(404)` inside
 * `res.status(404).json(body)`. The chain is one write, and the
 * terminal already records what each link contributed. A call written
 * as the terminal's argument is not a link and stays an effect.
 */
function writesTerminal(call: Node, terminalNodes: ReadonlySet<Node>): boolean {
  let current: Node = call;
  for (;;) {
    if (terminalNodes.has(current)) {
      return true;
    }
    const parent = current.getParent();
    if (parent === undefined || !isReceiverOf(current, parent)) {
      return false;
    }
    current = parent;
  }
}

/** Whether `parent` reads `node` as the thing it calls or accesses. */
function isReceiverOf(node: Node, parent: Node): boolean {
  return (
    (Node.isPropertyAccessExpression(parent) ||
      Node.isElementAccessExpression(parent) ||
      Node.isCallExpression(parent)) &&
    parent.getExpression() === node
  );
}

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
  resolution?: ResolutionStore,
  originatesFrom?: OriginatesFrom,
  anchorCallsOf?: AnchorCallsOf,
  resolveCallee?: ResolveCallee,
): RawBranchResult {
  const terminals = findTerminals(
    func,
    terminalPatterns,
    barriers,
    resolution,
    originatesFrom,
    resolveCallee,
  );
  const resolveWrittenValue =
    resolution === undefined
      ? undefined
      : (value: Node) => resolution.resolveWrittenValue(value);
  const invocations = extractInvocationEffects(func, barriers);
  const recognized = [
    ...runInvocationRecognizers(
      func,
      invocationRecognizers,
      barriers,
      resolveWrittenValue,
      originatesFrom,
      anchorCallsOf,
    ),
    ...runAccessRecognizers(
      func,
      accessRecognizers,
      barriers,
      resolveWrittenValue,
      originatesFrom,
      anchorCallsOf,
    ),
  ];

  // One condition list per path from entry to terminal. Anything the
  // path engine cannot enumerate comes back as the enclosing conditions
  // plus an opaque conjunct, so there is no second code path here.
  const { byTerminal } = computePathConditions(
    func,
    terminals.map(({ node }) => node),
    barriers,
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
  const fallthroughPattern = terminalPatterns.find(
    (p) => p.match.type === "functionFallthrough",
  );
  if (fallthroughPattern !== undefined && functionMayFallThrough(func)) {
    const hasDefaultTerminal = terminals.some(({ node }) =>
      (byTerminal.get(node) ?? []).some(isDefaultConditionList),
    );
    if (!hasDefaultTerminal) {
      const synthetic = makeFallthroughTerminal(func, fallthroughPattern);
      terminals.push(synthetic);
      // The synthetic terminal anchors at the body itself; its
      // condition lists are the paths that fall through the body's end.
      const pathResult = computePathConditions(
        func,
        [synthetic.node],
        barriers,
      );
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

  if (invocations.length > 0) {
    // A call the terminal reader itself matched, `res.json(body)`, is
    // the terminal and would otherwise count twice. A call whose result
    // a terminal describes, `return toView(row)`, is a different node.
    const terminalNodes = new Set(terminals.map(({ node }) => node));
    const sideEffects = invocations.filter(
      (i) => !writesTerminal(i.node, terminalNodes),
    );
    for (const branch of distinctBranches) {
      branch.effects = sideEffects
        .filter((i) =>
          firesOn({ ...i, preconditions: preconditionsOf(i.effect) }, branch),
        )
        .map((i) => i.effect);
    }
  }

  // A recognized effect is additive to the invocation effect from the
  // same call, so it skips the terminal dedup and only takes the two
  // branch tests.
  for (const branch of distinctBranches) {
    const extra: Effect[] = recognized
      .filter((r) => firesOn(r, branch))
      .map((r) => r.effect);
    if (extra.length > 0) {
      branch.extraEffects = [...(branch.extraEffects ?? []), ...extra];
    }
  }

  return { branches: distinctBranches, terminals };
}
