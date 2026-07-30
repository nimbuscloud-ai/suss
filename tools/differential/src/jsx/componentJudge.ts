// componentJudge.ts — adjudicate observed renders against summary claims.
//
// Same two verdicts as the HTTP judge, different observable. A
// transition's *conditions* are evaluated with the shared three-valued
// interpreter (props env). Its *claim* is read from the output:
// `return null` claims "renders nothing"; a `render` output claims a
// `RenderNode` tree. Tree admissibility is deliberately conservative —
// it extracts only the *certain* facts a claim commits to (root tag,
// element tags and text outside any conditional) and the *possible*
// facts it allows (conditional branches), and abstains wherever the
// claim contains expression nodes (verbatim source text — decision
// #38's v0 shape). Abstention can neither falsify nor be falsified.

import { type DispatchTable, dispatchByType } from "../dispatch.js";
import { evalConditions, type Tri } from "../interpret.js";

import type {
  BehavioralSummary,
  Output,
  RenderNode,
  Transition,
} from "@suss/behavioral-ir";
import type { ObservedNode, ObservedRender } from "./componentExecute.js";

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export type RenderClaim =
  | { type: "nothing" }
  | { type: "tree"; component: string; root: RenderNode | null }
  | { type: "nonRender" }
  | { type: "unknownClaim" };

const CLAIMS: DispatchTable<Output, RenderClaim> = {
  return: (output) =>
    output.value !== null && output.value.type === "null"
      ? { type: "nothing" }
      : { type: "unknownClaim" },
  render: (output) => ({
    type: "tree",
    component: output.component,
    root: output.root ?? null,
  }),
  response: () => ({ type: "nonRender" }),
  throw: () => ({ type: "nonRender" }),
  delegate: () => ({ type: "nonRender" }),
  emit: () => ({ type: "nonRender" }),
  void: () => ({ type: "nonRender" }),
};

export function renderClaim(transition: Transition): RenderClaim {
  return dispatchByType(CLAIMS, transition.output);
}

// ---------------------------------------------------------------------------
// Claimed-tree facts
// ---------------------------------------------------------------------------

interface ClaimFacts {
  /** tag → count of elements guaranteed to render. */
  certainTags: Map<string, number>;
  /** tag → max count of elements that could render (certain + branches). */
  possibleTags: Map<string, number>;
  /** Trimmed text values guaranteed to render. */
  certainTexts: Map<string, number>;
  /** Trimmed text values that could render. */
  possibleTexts: Map<string, number>;
  /** Any expression node — its runtime contribution is unknowable. */
  hasExpression: boolean;
  /** Any conditional node — full confirmation impossible. */
  hasConditional: boolean;
}

const bump = (map: Map<string, number>, key: string, by: number): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};

function emptyFacts(): ClaimFacts {
  return {
    certainTags: new Map(),
    possibleTags: new Map(),
    certainTexts: new Map(),
    possibleTexts: new Map(),
    hasExpression: false,
    hasConditional: false,
  };
}

function collectClaimFacts(
  node: RenderNode,
  facts: ClaimFacts,
  certain: boolean,
): void {
  const table: DispatchTable<RenderNode, undefined> = {
    element: (n) => {
      if (certain) {
        bump(facts.certainTags, n.tag, 1);
      }
      bump(facts.possibleTags, n.tag, 1);
      for (const child of n.children) {
        collectClaimFacts(child, facts, certain);
      }
      return undefined;
    },
    text: (n) => {
      const value = n.value.trim();
      if (value !== "") {
        if (certain) {
          bump(facts.certainTexts, value, 1);
        }
        bump(facts.possibleTexts, value, 1);
      }
      return undefined;
    },
    expression: () => {
      facts.hasExpression = true;
      return undefined;
    },
    conditional: (n) => {
      facts.hasConditional = true;
      // Both branches are possible, neither is certain — the condition
      // text is verbatim source (not a structured Predicate), so the
      // judge abstains on which branch fires.
      collectClaimFacts(n.whenTrue, facts, false);
      if (n.whenFalse !== null) {
        collectClaimFacts(n.whenFalse, facts, false);
      }
      return undefined;
    },
  };
  dispatchByType(table, node);
}

// ---------------------------------------------------------------------------
// Observed-tree facts
// ---------------------------------------------------------------------------

interface ObservedFacts {
  tags: Map<string, number>;
  texts: Map<string, number>;
}

function collectObservedFacts(node: ObservedNode, facts: ObservedFacts): void {
  if (node.type === "text") {
    const value = node.value.trim();
    if (value !== "") {
      bump(facts.texts, value, 1);
    }
    return;
  }
  bump(facts.tags, node.tag, 1);
  for (const child of node.children) {
    collectObservedFacts(child, facts);
  }
}

// ---------------------------------------------------------------------------
// Admissibility
// ---------------------------------------------------------------------------

/**
 * Does the claimed tree admit the observed one? "false" is a proven
 * disagreement; "unknown" means conditionals/expressions in the claim
 * prevented full confirmation; "true" means exact structural agreement.
 */
export function treeAdmits(root: RenderNode, observed: ObservedNode): Tri {
  if (
    root.type === "element" &&
    (observed.type !== "element" || root.tag !== observed.tag)
  ) {
    return "false";
  }

  const claim = emptyFacts();
  collectClaimFacts(root, claim, true);
  const seen: ObservedFacts = { tags: new Map(), texts: new Map() };
  collectObservedFacts(observed, seen);

  // Certain structure must appear in the observation.
  for (const [tag, count] of claim.certainTags) {
    if ((seen.tags.get(tag) ?? 0) < count) {
      return "false";
    }
  }
  for (const [text, count] of claim.certainTexts) {
    if ((seen.texts.get(text) ?? 0) < count) {
      return "false";
    }
  }

  // The observation must be explainable by the claim — but only when
  // the claim has no expression nodes (an expression could render
  // anything, so nothing observed is inexplicable).
  if (!claim.hasExpression) {
    for (const [tag, count] of seen.tags) {
      if ((claim.possibleTags.get(tag) ?? 0) < count) {
        return "false";
      }
    }
    for (const [text, count] of seen.texts) {
      if ((claim.possibleTexts.get(text) ?? 0) < count) {
        return "false";
      }
    }
  }

  if (claim.hasExpression || claim.hasConditional) {
    return "unknown";
  }
  return "true";
}

const claimAdmitsTable: DispatchTable<
  RenderClaim,
  (observed: ObservedRender) => Tri
> = {
  nothing: () => (observed) => (observed === null ? "true" : "false"),
  tree: (claim) => (observed) => {
    if (observed === null) {
      return "false";
    }
    if (claim.root !== null) {
      return treeAdmits(claim.root, observed);
    }
    // No structured tree — only the root component name is claimed.
    if (observed.type !== "element") {
      return "false";
    }
    return claim.component === observed.tag ? "unknown" : "false";
  },
  nonRender: () => () => "false",
  unknownClaim: () => () => "unknown",
};

export function claimAdmits(claim: RenderClaim, observed: ObservedRender): Tri {
  return dispatchByType(claimAdmitsTable, claim)(observed);
}

// ---------------------------------------------------------------------------
// Judgment
// ---------------------------------------------------------------------------

export interface RenderMismatch {
  verdict: "falseClaim" | "uncovered";
  props: Record<string, string>;
  observed: ObservedRender;
  detail: string;
}

interface RenderEvaluation {
  transition: Transition;
  conditions: Tri;
  admits: Tri;
}

function describeEvaluation(evaluation: RenderEvaluation): string {
  return `${evaluation.transition.id} (conditions: ${evaluation.conditions}, admits: ${evaluation.admits})`;
}

export function judgeRenderObservation(
  summary: BehavioralSummary,
  props: Record<string, string>,
  observed: ObservedRender,
): RenderMismatch | null {
  const env: Record<string, unknown> = { ...props };
  const evaluations: RenderEvaluation[] = summary.transitions.map(
    (transition) => ({
      transition,
      conditions: evalConditions(transition.conditions, env),
      admits: claimAdmits(renderClaim(transition), observed),
    }),
  );

  const falseClaims = evaluations.filter(
    (e) => e.conditions === "true" && e.admits === "false",
  );
  if (falseClaims.length > 0) {
    return {
      verdict: "falseClaim",
      props,
      observed,
      detail:
        "transitions with all-true conditions cannot admit the observed render: " +
        falseClaims.map(describeEvaluation).join("; "),
    };
  }

  const covered = evaluations.some(
    (e) =>
      (e.conditions === "true" || e.conditions === "unknown") &&
      e.admits !== "false",
  );
  if (!covered && summary.gaps.length === 0) {
    return {
      verdict: "uncovered",
      props,
      observed,
      detail:
        "no transition's conditions and claim admit the observed render. Transitions: " +
        evaluations.map(describeEvaluation).join("; "),
    };
  }

  return null;
}
