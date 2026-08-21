/**
 * Turn a witness proof over the resolution rules into the chain a
 * person reads: which value led to which, one reason per hop, with the
 * assumptions the chain rests on called out.
 *
 * This module knows which rules are hops and which are plumbing: a
 * `stepsTo` firing is a hop somebody should see, a `reaches` firing is
 * the closure gluing hops together, and the base cases ("x is already
 * a function") end a chain without adding to it. Everything here is
 * about the resolution rules; the engine stays prose-free. Atoms in a
 * proof are the adapter's node ids, so every sentence goes through a
 * caller-supplied `describe` to say them in source terms.
 */

import { ruleLabel } from "@suss/datalog";

import type { Atom, Proof, ProofDerived, Tuple } from "@suss/datalog";

/** How a caller says an atom in source terms: a name, a file, a line. */
export type DescribeAtom = (atom: Atom) => string;

/** One hop of a chain, with the sentence saying why it is true. */
export interface ResolutionStep {
  from: Atom;
  to: Atom;
  /** The rule that fired, by the name it was given. */
  rule: string;
  /** Why this hop is true, in one sentence. */
  reason: string;
  /** Detail under the hop: barrel re-exports, a callee's own chain. */
  notes: string[];
  /** What the hop rests on beyond what the source says. */
  assumptions: string[];
}

export interface ResolutionExplanation {
  /** The chain's atoms in order, the asked-about value first. */
  atoms: Atom[];
  steps: ResolutionStep[];
  /** All assumptions from every step, in chain order. */
  assumptions: string[];
  /** True when the depth cap or the cycle guard stopped the walk. */
  truncated: boolean;
}

/** What a phrase reads: the fired rule's premises, spoken through `describe`. */
export interface StepContext {
  tuple: Tuple;
  premises: readonly Proof[];
  describe: DescribeAtom;
  /** Render a nested proof's own hops, for a callee with a chain of its own. */
  inline: (proof: Proof) => string[];
}

export type StepPhrase = (context: StepContext) => {
  reason: string;
  notes?: string[];
  assumptions?: string[];
};

// ---------------------------------------------------------------------------
// Phrases, one per named step rule
// ---------------------------------------------------------------------------

/**
 * The barrel hops under a `moduleExport` proof, one line each, so an
 * import through a re-export chain says which files forwarded it.
 */
function exportTrail(proof: Proof, describe: DescribeAtom): string[] {
  if (proof.kind !== "derived") {
    return [];
  }
  const name = ruleLabel(proof.rule);
  if (name === "re-export") {
    const [m, n, m2, n2] = proof.premises[0].tuple;
    return [
      `${describe(m)} takes ${String(n)} from ${describe(m2)}, where it is called ${String(n2)}`,
      ...exportTrail(proof.premises[1], describe),
    ];
  }
  if (name === "re-export all") {
    const [m, m2] = proof.premises[0].tuple;
    return [
      `${describe(m)} forwards everything ${describe(m2)} exports`,
      ...exportTrail(proof.premises[1], describe),
    ];
  }
  return [];
}

/**
 * The sentence for a `passesArgument` proof, which is how both the
 * positional and the keyword form of a call reach a parameter.
 */
function argumentReason(proof: Proof, describe: DescribeAtom): string {
  const [, p, a] = proof.tuple;
  if (proof.kind !== "derived") {
    return `${describe(p)} is a parameter, and a call passes it ${describe(a)}`;
  }
  const f = proof.premises[0].tuple[0];
  return `${describe(p)} is a parameter of ${describe(f)}, and a call passes it ${describe(a)}`;
}

const DEFAULT_PHRASES: Record<string, StepPhrase> = {
  alias: ({ tuple, describe }) => ({
    reason: `${describe(tuple[0])} is declared as ${describe(tuple[1])}`,
  }),
  "last write": ({ tuple, describe }) => ({
    reason: `${describe(tuple[0])} is written more than once, and the last write leaves it as ${describe(tuple[1])}`,
  }),
  fallback: ({ tuple, describe }) => ({
    reason: `${describe(tuple[0])} is a fallback expression, and ${describe(tuple[1])} is the branch that resolves`,
  }),
  import: ({ tuple, premises, describe }) => {
    const [, module, name] = premises[0].tuple;
    return {
      reason: `${describe(tuple[0])} is imported from ${describe(module)} under the name ${String(name)}`,
      notes: exportTrail(premises[1], describe),
    };
  },
  argument: ({ premises, describe }) => ({
    reason: argumentReason(premises[0], describe),
  }),
  "property read": ({ tuple, premises, describe }) => {
    const [, object, name] = premises[0].tuple;
    const contains = premises[2];
    const inherited =
      contains.kind === "derived" && contains.premises.length > 1;
    return {
      reason: `${describe(tuple[0])} reads ${String(name)} off ${describe(object)}, which contains ${describe(tuple[1])}`,
      notes: inherited ? [`${String(name)} comes from a base class`] : [],
    };
  },
  "class instance": ({ tuple, premises, describe, inline }) => ({
    reason: `${describe(tuple[0])} makes an instance of ${describe(tuple[1])}`,
    notes: inline(premises[1]),
  }),
  "factory unwrap": ({ tuple, premises, describe, inline }) => {
    const factory = premises[1].tuple[1];
    return {
      reason: `${describe(tuple[0])} calls ${describe(factory)}, a factory that passes its argument through, so it comes down to ${describe(tuple[1])}`,
      notes: inline(premises[1]),
    };
  },
  "declared wrapper": ({ tuple, premises, describe }) => {
    const callee = String(premises[0].tuple[1]);
    const module = String(premises[2].tuple[1]);
    const argument = String(premises[1].tuple[1]);
    return {
      reason: `${describe(tuple[0])} calls ${callee} from ${module}, which passes argument ${argument} through, so it comes down to ${describe(tuple[1])}`,
      assumptions: [
        `a pack declares that ${callee} from ${module} passes argument ${argument} through to its result`,
      ],
    };
  },
  "call result": ({ tuple, premises, describe, inline }) => {
    const invokes = premises[0];
    const invoked = invokes.tuple[1];
    // The callee's own chain is inside the `invokes` proof, which is
    // itself no chain, so the walk premises under it are what to show.
    const calleeWalks =
      invokes.kind === "derived"
        ? invokes.premises.filter(
            (premise) =>
              premise.kind === "derived" &&
              (premise.relation === "comesTo" ||
                premise.relation === "givesBack"),
          )
        : [];
    return {
      reason: `${describe(tuple[0])} runs ${describe(invoked)}, which returns ${describe(tuple[1])}`,
      notes: calleeWalks.flatMap((premise) => inline(premise)),
    };
  },
};

// ---------------------------------------------------------------------------
// Walking a proof into a chain
// ---------------------------------------------------------------------------

/** The relations whose proof is a chain this module can flatten. */
const CHAIN_RELATIONS = new Set([
  "resolves",
  "comesTo",
  "givesBack",
  "isWrittenAs",
  "comesFrom",
  "reaches",
  "stepsTo",
]);

interface WalkState {
  steps: ResolutionStep[];
  truncated: boolean;
  describe: DescribeAtom;
  phrases: Record<string, StepPhrase>;
}

/**
 * A nested proof rendered as indented sentences: the chain a callee or
 * a class name followed before the current hop could fire.
 */
function inlineChain(proof: Proof, state: WalkState): string[] {
  const explained = explainResolutionProof(proof, {
    describe: state.describe,
    phrases: state.phrases,
  });
  if (explained === null || explained.steps.length === 0) {
    return [];
  }
  if (explained.truncated) {
    state.truncated = true;
  }
  return explained.steps.map((step) => step.reason);
}

function stepFrom(proof: ProofDerived, state: WalkState): ResolutionStep {
  const name = ruleLabel(proof.rule);
  const phrase = state.phrases[name];
  const from = proof.tuple[0];
  const to = proof.tuple[1];
  if (phrase === undefined) {
    return {
      from,
      to,
      rule: name,
      reason: `${state.describe(from)} steps to ${state.describe(to)} (${name})`,
      notes: [],
      assumptions: [],
    };
  }
  const said = phrase({
    tuple: proof.tuple,
    premises: proof.premises,
    describe: state.describe,
    inline: (nested) => inlineChain(nested, state),
  });
  return {
    from,
    to,
    rule: name,
    reason: said.reason,
    notes: said.notes ?? [],
    assumptions: said.assumptions ?? [],
  };
}

/** The final hop of a `comesFrom` proof: the import itself. */
function importStep(proof: Proof, state: WalkState): ResolutionStep {
  const [x, module, name] = proof.tuple;
  return {
    from: x,
    to: module,
    rule: "import",
    reason: `${state.describe(x)} is imported from ${state.describe(module)} under the name ${String(name)}`,
    notes: [],
    assumptions: [],
  };
}

const flattenInto = (proof: Proof, state: WalkState): void => {
  if (proof.kind === "truncated") {
    state.truncated = true;
    return;
  }
  if (proof.kind !== "derived") {
    return;
  }

  const relation = proof.relation;
  if (relation === "stepsTo") {
    state.steps.push(stepFrom(proof, state));
    return;
  }
  if (relation === "reaches") {
    for (const p of proof.premises) {
      flattenInto(p, state);
    }
    return;
  }
  if (relation === "comesFrom") {
    // The last premise is the import; the one before it, when there is
    // one, is the walk that got there.
    if (proof.premises.length === 2) {
      flattenInto(proof.premises[0], state);
      state.steps.push(importStep(proof.premises[1], state));
    } else {
      state.steps.push(importStep(proof.premises[0], state));
    }
    return;
  }
  // resolves, comesTo, givesBack, isWrittenAs: the chain is in the walk
  // premise, and the base cases add no hops.
  for (const p of proof.premises) {
    if (
      p.kind === "derived" &&
      (p.relation === "reaches" || p.relation === "comesTo")
    ) {
      flattenInto(p, state);
    }
    if (p.kind === "truncated") {
      state.truncated = true;
    }
  }
};

export interface ExplainOptions {
  describe: DescribeAtom;
  /** Phrases for a caller's own step rules, over the built-in ones. */
  phrases?: Record<string, StepPhrase>;
}

/**
 * Flatten a proof of one resolution answer into its chain. Returns
 * null for a proof that is not over these rules: an absence (the fact
 * was never derived), or some other rule set's relation.
 */
export function explainResolutionProof(
  proof: Proof,
  options: ExplainOptions,
): ResolutionExplanation | null {
  if (proof.kind === "absence") {
    return null;
  }
  if (proof.kind === "derived" && !CHAIN_RELATIONS.has(proof.relation)) {
    return null;
  }
  const state: WalkState = {
    steps: [],
    truncated: proof.kind === "truncated",
    describe: options.describe,
    phrases: { ...DEFAULT_PHRASES, ...options.phrases },
  };
  flattenInto(proof, state);
  const atoms: Atom[] =
    proof.kind === "fact" || proof.kind === "truncated"
      ? [proof.tuple[0]]
      : [proof.tuple[0], ...state.steps.map((step) => step.to)];
  return {
    atoms,
    steps: state.steps,
    assumptions: state.steps.flatMap((step) => step.assumptions),
    truncated: state.truncated,
  };
}

/**
 * The explanation as lines a report prints: the chain first, then one
 * reason per hop with its notes indented under it, then what the chain
 * assumes. A truncated walk says so instead of trailing off.
 */
export function renderExplanation(
  explanation: ResolutionExplanation,
  describe: DescribeAtom,
): string[] {
  const lines: string[] = [];
  if (explanation.steps.length > 0) {
    lines.push(explanation.atoms.map((atom) => describe(atom)).join(" -> "));
  }
  for (const step of explanation.steps) {
    lines.push(`  ${step.reason}`);
    for (const note of step.notes) {
      lines.push(`    ${note}`);
    }
  }
  for (const assumption of explanation.assumptions) {
    lines.push(`  assuming ${assumption}`);
  }
  if (explanation.truncated) {
    lines.push("  the chain goes on past the proof depth cap");
  }
  return lines;
}
